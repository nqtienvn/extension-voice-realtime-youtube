/*
 * Runs in YouTube's tab.  Keeping TTS here avoids a background/service-worker
 * round trip and avoids any network call: this is the shortest path available
 * to an available Chrome/system voice.
 */
(() => {
  const VIETNAMESE_LANG = "vi-VN";
  const TTS_SETTINGS_VERSION = 1;
  const LEGACY_DEFAULT_RATE = 1.35;
  const MIN_SPEECH_RATE = 0.75;
  const MAX_SPEECH_RATE = 3;
  const VOICE_LOAD_WAIT_MS = 600;
  const CATCH_UP_RATE_STEP = 0.1;
  const MAX_CATCH_UP_MULTIPLIER = 1.3;
  const DEFAULTS = {
    enabled: true,
    rate: 1,
    pitch: 1,
    volume: 1,
    voiceURI: "",
    ttsSettingsVersion: 0
  };
  const CAPTION_SETTLE_MS = 40;
  const CAPTION_MAX_WAIT_MS = 180;
  const SPEECH_BATCH_SETTLE_MS = 260;
  const SPEECH_BATCH_MAX_WAIT_MS = 550;
  const TRANSCRIPT_MESSAGES = Object.freeze({
    GET_STATE: "transcript:getState",
    START: "transcript:start",
    STOP: "transcript:stop",
    CLEAR: "transcript:clear",
    EXPORT: "transcript:export"
  });

  let settings = { ...DEFAULTS };
  let displayedCaption = { text: "", nodes: [], lines: [] };
  let observedCaption = { text: "", nodes: [], lines: [] };
  let scheduledCaption = null;
  let captionTimer = null;
  let captionDeadlineTimer = null;
  let captionMutationPending = false;
  const speechQueue = [];
  let activeUtterance = null;
  let speechGeneration = 0;
  let pendingSpeechText = "";
  let pendingSpeechAttachesToPrevious = false;
  let pendingSpeechStartsNewEntry = false;
  let pendingTailHasQueuedStablePrefix = false;
  let speechBatchTimer = null;
  let speechBatchDeadlineTimer = null;
  let rollUpLineage = null;
  let observer = null;
  let voiceLoadWaitTimer = null;
  let voiceLoadWaitFinished = false;
  const voiceLoadWaitDeadline = Date.now() + VOICE_LOAD_WAIT_MS;
  let transcriptSession = createEmptyTranscriptSession();

  function normalize(text) {
    return String(text ?? "")
      .normalize("NFC")
      .replace(
        /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu,
        ""
      )
      .replace(/\s+/gu, " ")
      .replace(/\s+([,.;:!?…])/gu, "$1")
      .trim();
  }

  const NON_SPEECH_CUES = new Set([
    "music",
    "applause",
    "laughter",
    "cheering",
    "inaudible",
    "unintelligible",
    "nhạc",
    "âm nhạc",
    "tiếng nhạc",
    "vỗ tay",
    "tiếng vỗ tay",
    "cười",
    "tiếng cười",
    "cổ vũ",
    "reo hò",
    "không nghe rõ"
  ]);

  function prepareSpeechText(text) {
    let prepared = normalize(text)
      .replace(/\[([^\[\]]+)\]/gu, (match, square) => {
        const cue = normalize(square).toLocaleLowerCase("vi");
        return NON_SPEECH_CUES.has(cue) ? " " : match;
      })
      .replace(/^\(([^()]+)\)$/u, (match, round) => {
        const cue = normalize(round).toLocaleLowerCase("vi");
        return NON_SPEECH_CUES.has(cue) ? "" : match;
      })
      .replace(/[♪♫♬]+/gu, " ");

    // Expand only numeric-adjacent symbols whose Vietnamese reading is
    // unambiguous. Keep acronyms, dates, versions, URLs, and generic symbols.
    prepared = prepared
      .replace(
        /(^|[^\p{L}\p{N}_])(\d[\d.,]*)%(?![\p{L}\p{N}_])/gu,
        "$1$2 phần trăm"
      )
      .replace(
        /(^|[^\p{L}\p{N}_])(\d[\d.,]*)\s*₫(?![\p{L}\p{N}_])/gu,
        "$1$2 đồng"
      )
      .replace(
        /(^|[^\p{L}\p{N}_])(\d[\d.,]*)\s*°\s*[cC](?![\p{L}\p{N}_])/gu,
        "$1$2 độ C"
      );

    return normalize(prepared);
  }

  function appendSpeechText(base, addition, attachToPrevious = false) {
    if (!base) return normalize(addition);
    if (!addition) return normalize(base);
    return normalize(
      attachToPrevious ? `${base}${addition}` : `${base} ${addition}`
    );
  }

  function currentCaption() {
    // ytp-caption-segment is the element currently painted by the YouTube player.
    // It is deliberately read, rather than calling YouTube's transcript APIs, so
    // the spoken text exactly follows the visible subtitle.
    const segments = document.querySelectorAll(
      ".ytp-caption-window-container .ytp-caption-segment"
    );
    const nodes = Array.from(segments);
    if (!nodes.length) return { text: "", nodes, lines: [] };

    const lineGroups = [];
    const groupsByNode = new Map();

    for (const segment of nodes) {
      const closestLine =
        typeof segment.closest === "function"
          ? segment.closest(".caption-visual-line")
          : null;
      const lineNode = closestLine || segment.parentElement || segment;
      let group = groupsByNode.get(lineNode);

      if (!group) {
        group = { node: lineNode, segments: [] };
        groupsByNode.set(lineNode, group);
        lineGroups.push(group);
      }

      group.segments.push(segment);
    }

    const lines = lineGroups
      .map((group) => ({
        node: group.node,
        text: normalize(
          group.segments.map((segment) => segment.textContent || "").join(" ")
        )
      }))
      .filter((line) => line.text);

    return {
      text: normalize(lines.map((line) => line.text).join(" ")),
      nodes,
      lines
    };
  }

  function createEmptyTranscriptSession() {
    return {
      recording: false,
      entries: [],
      videoKey: "",
      videoId: "",
      videoTitle: "",
      videoUrl: "",
      startedAt: "",
      entryBoundaryPending: false,
      stoppedBecauseVideoChanged: false
    };
  }

  function decodedUrlPart(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function currentVideoMetadata() {
    const href =
      typeof location === "object" && typeof location.href === "string"
        ? location.href
        : "";
    const queryVideoId = href.match(/[?&]v=([^&#]+)/u);
    const pathVideoId = href.match(/\/(?:shorts|live)\/([^/?#&]+)/u);
    const videoId = decodedUrlPart(
      (queryVideoId && queryVideoId[1]) ||
        (pathVideoId && pathVideoId[1]) ||
        ""
    );
    const rawTitle =
      typeof document.title === "string" ? document.title : "YouTube";
    const videoTitle =
      normalize(rawTitle.replace(/\s*-\s*YouTube\s*$/iu, "")) || "YouTube";

    return {
      videoKey: videoId
        ? `video:${videoId}`
        : `page:${href.split("#", 1)[0] || "youtube"}`,
      videoId,
      videoTitle,
      videoUrl: videoId
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
        : href
    };
  }

  function currentVideoTime() {
    const video =
      typeof document.querySelector === "function"
        ? document.querySelector("video")
        : null;
    const value = Number(video && video.currentTime);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function initializeTranscriptSession(metadata = currentVideoMetadata()) {
    transcriptSession = {
      ...createEmptyTranscriptSession(),
      videoKey: metadata.videoKey,
      videoId: metadata.videoId,
      videoTitle: metadata.videoTitle,
      videoUrl: metadata.videoUrl,
      startedAt: new Date().toISOString()
    };
  }

  function transcriptMatchesCurrentVideo() {
    if (!transcriptSession.videoKey) return true;
    const matches =
      currentVideoMetadata().videoKey === transcriptSession.videoKey;
    if (!matches && transcriptSession.recording) {
      transcriptSession.recording = false;
      transcriptSession.stoppedBecauseVideoChanged = true;
    }
    return matches;
  }

  function transcriptWordCount() {
    return transcriptSession.entries.reduce(
      (count, entry) =>
        count + entry.text.split(/\s+/u).filter(Boolean).length,
      0
    );
  }

  function transcriptState() {
    transcriptMatchesCurrentVideo();
    return {
      recording: transcriptSession.recording,
      hasContent: transcriptSession.entries.length > 0,
      entryCount: transcriptSession.entries.length,
      wordCount: transcriptWordCount(),
      startedAt: transcriptSession.startedAt,
      videoId: transcriptSession.videoId,
      videoTitle: transcriptSession.videoTitle,
      stoppedBecauseVideoChanged: transcriptSession.stoppedBecauseVideoChanged
    };
  }

  function transcriptEndsWithCaption(text) {
    const caption = normalize(text);
    const lastEntry = transcriptSession.entries.at(-1);
    if (!caption || !lastEntry) return false;
    return (
      lastEntry.text === caption ||
      lastEntry.text.endsWith(` ${caption}`)
    );
  }

  function recordTranscriptAddition(
    text,
    attachToPrevious = false,
    startsNewEntry = false
  ) {
    const addition = normalize(text);
    if (
      !transcriptSession.recording ||
      !transcriptMatchesCurrentVideo() ||
      !addition
    ) {
      return;
    }

    const playbackTime = currentVideoTime();
    const lastEntry = transcriptSession.entries.at(-1);
    if (
      !lastEntry ||
      startsNewEntry ||
      transcriptSession.entryBoundaryPending
    ) {
      transcriptSession.entries.push({
        startSeconds: playbackTime,
        endSeconds: playbackTime,
        text: addition
      });
      transcriptSession.entryBoundaryPending = false;
      return;
    }

    lastEntry.text = appendSpeechText(
      lastEntry.text,
      addition,
      attachToPrevious
    );
    lastEntry.endSeconds = Math.max(lastEntry.endSeconds, playbackTime);
  }

  function isLikelyTranscriptCaptionRevision(previousText, currentText) {
    if (isLikelyTrailingWordCorrection(previousText, currentText)) return true;
    if (previousText.startsWith(currentText)) return false;

    const previousWords = previousText.split(" ");
    const currentWords = currentText.split(" ");
    if (
      previousWords.length === currentWords.length ||
      !previousWords.length ||
      !currentWords.length
    ) {
      return false;
    }

    const shorterLength = Math.min(
      previousWords.length,
      currentWords.length
    );
    let sharedPrefix = 0;
    while (
      sharedPrefix < shorterLength &&
      previousWords[sharedPrefix] === currentWords[sharedPrefix]
    ) {
      sharedPrefix += 1;
    }

    let sharedSuffix = 0;
    while (
      sharedPrefix + sharedSuffix < shorterLength &&
      previousWords[previousWords.length - 1 - sharedSuffix] ===
        currentWords[currentWords.length - 1 - sharedSuffix]
    ) {
      sharedSuffix += 1;
    }

    const unchangedWords = sharedPrefix + sharedSuffix;
    return unchangedWords >= 2 && unchangedWords / shorterLength >= 0.75;
  }

  function replaceTranscriptCaptionRevision(previousText, currentText) {
    if (
      !transcriptSession.recording ||
      !transcriptMatchesCurrentVideo() ||
      !isLikelyTranscriptCaptionRevision(previousText, currentText)
    ) {
      return false;
    }

    const previous = normalize(previousText);
    const current = normalize(currentText);
    const lastEntry = transcriptSession.entries.at(-1);
    if (!previous || !current || !lastEntry.text.endsWith(previous)) {
      return false;
    }

    lastEntry.text = normalize(
      `${lastEntry.text.slice(0, -previous.length)}${current}`
    );
    lastEntry.endSeconds = Math.max(lastEntry.endSeconds, currentVideoTime());
    return true;
  }

  function formatPlaybackTime(value) {
    const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  }

  function safeFilenamePart(value, fallback) {
    const safe = normalize(value)
      .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-")
      .replace(/\s+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^[.\s-]+|[.\s-]+$/gu, "")
      .slice(0, 80);
    return safe || fallback;
  }

  function transcriptFilename() {
    const title = safeFilenamePart(
      transcriptSession.videoTitle,
      "youtube"
    );
    const videoId = safeFilenamePart(
      transcriptSession.videoId,
      "khong-ro-video"
    );
    const timestamp = (transcriptSession.startedAt || new Date().toISOString())
      .replace(/\.\d{3}Z$/u, "Z")
      .replace(/[:T]/gu, "-");
    return `youtube-phu-de_${title}_${videoId}_${timestamp}.txt`;
  }

  function transcriptExportContent() {
    const lines = [
      "BẢN GHI PHỤ ĐỀ YOUTUBE",
      `Tiêu đề: ${transcriptSession.videoTitle || "YouTube"}`,
      `Video: ${transcriptSession.videoUrl || ""}`,
      `Bắt đầu ghi: ${transcriptSession.startedAt || ""}`,
      ""
    ];

    for (const entry of transcriptSession.entries) {
      lines.push(`[${formatPlaybackTime(entry.startSeconds)}] ${entry.text}`);
    }
    return lines.join("\r\n");
  }

  function startTranscript(resetExisting = false) {
    // Commit the latest debounced caption before taking the starting snapshot,
    // so the snapshot and future caption deltas share the same watermark.
    flushScheduledCaption();
    const metadata = currentVideoMetadata();
    if (
      resetExisting ||
      !transcriptSession.videoKey ||
      transcriptSession.videoKey !== metadata.videoKey
    ) {
      initializeTranscriptSession(metadata);
    }

    transcriptSession.recording = true;
    transcriptSession.stoppedBecauseVideoChanged = false;
    const caption = currentCaption();
    if (caption.text && !transcriptEndsWithCaption(caption.text)) {
      recordTranscriptAddition(caption.text, false, true);
    }
    return transcriptState();
  }

  function stopTranscript() {
    if (transcriptSession.recording) flushScheduledCaption();
    transcriptSession.recording = false;
    return transcriptState();
  }

  function clearTranscript() {
    transcriptSession = createEmptyTranscriptSession();
    return transcriptState();
  }

  function handleTranscriptMessage(message, _sender, sendResponse) {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === TRANSCRIPT_MESSAGES.GET_STATE) {
      sendResponse({ ok: true, state: transcriptState() });
      return false;
    }
    if (message.type === TRANSCRIPT_MESSAGES.START) {
      sendResponse({
        ok: true,
        state: startTranscript(Boolean(message.reset))
      });
      return false;
    }
    if (message.type === TRANSCRIPT_MESSAGES.STOP) {
      sendResponse({ ok: true, state: stopTranscript() });
      return false;
    }
    if (message.type === TRANSCRIPT_MESSAGES.CLEAR) {
      sendResponse({ ok: true, state: clearTranscript() });
      return false;
    }
    if (message.type === TRANSCRIPT_MESSAGES.EXPORT) {
      if (transcriptSession.recording) flushScheduledCaption();
      if (!transcriptSession.entries.length) {
        sendResponse({
          ok: false,
          error: "Chưa có phụ đề nào trong bản ghi."
        });
        return false;
      }
      sendResponse({
        ok: true,
        content: transcriptExportContent(),
        filename: transcriptFilename(),
        state: transcriptState()
      });
      return false;
    }
    return false;
  }

  function sharesCaptionNode(first, second) {
    if (!first.nodes.length || !second.nodes.length) return false;
    return first.nodes.some((node) => second.nodes.includes(node));
  }

  function sameCaptionObservation(first, second) {
    if (first.text !== second.text) return false;
    if (!first.text) return true;
    return sharesCaptionNode(first, second);
  }

  function isVietnameseVoice(voice) {
    return /^vi(?:-|$)/i.test(canonicalLanguageTag(voice.lang));
  }

  function canonicalLanguageTag(language) {
    const candidate = String(language || "").trim().replace(/_/g, "-");
    if (!candidate) return "";

    try {
      return Intl.getCanonicalLocales(candidate)[0] || "";
    } catch {
      return "";
    }
  }

  function voiceScore(voice) {
    const normalizedLang = canonicalLanguageTag(voice.lang).toLowerCase();
    return (
      (normalizedLang === VIETNAMESE_LANG.toLowerCase() ? 4 : 0) +
      (voice.default ? 2 : 0) +
      (voice.localService ? 1 : 0)
    );
  }

  function normalizedSpeechRate(value) {
    const numericRate = Number(value);
    if (!Number.isFinite(numericRate)) return DEFAULTS.rate;
    return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, numericRate));
  }

  function catchUpSpeechRate(value, backlogDepth) {
    const baseRate = normalizedSpeechRate(value);
    const extraEntries = Math.max(0, Number(backlogDepth) - 1);
    const multiplier = Math.min(
      MAX_CATCH_UP_MULTIPLIER,
      1 + extraEntries * CATCH_UP_RATE_STEP
    );
    return normalizedSpeechRate(baseRate * multiplier);
  }

  function configuredVoice() {
    return speechSynthesis.getVoices().find(
      (voice) => voice.voiceURI === settings.voiceURI
    );
  }

  function requestedVoice() {
    const voice = configuredVoice();
    return voice && isVietnameseVoice(voice) ? voice : null;
  }

  function selectedVoice() {
    const voices = speechSynthesis.getVoices();
    const requested = requestedVoice();
    if (requested) return requested;

    return (
      voices
        .filter(isVietnameseVoice)
        .sort((first, second) => voiceScore(second) - voiceScore(first))[0] ||
      null
    );
  }

  function createUtterance(text, backlogDepth = 1) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = catchUpSpeechRate(settings.rate, backlogDepth);
    utterance.pitch = Number(settings.pitch);
    utterance.volume = Number(settings.volume);
    utterance.lang = VIETNAMESE_LANG;

    const voice = selectedVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = canonicalLanguageTag(voice.lang) || VIETNAMESE_LANG;
    }

    return utterance;
  }

  function shouldWaitForRequestedVoice() {
    const configured = configuredVoice();
    if (
      !settings.voiceURI ||
      configured ||
      voiceLoadWaitFinished
    ) {
      return false;
    }

    const remainingWait = voiceLoadWaitDeadline - Date.now();
    if (remainingWait <= 0) {
      voiceLoadWaitFinished = true;
      return false;
    }

    if (!voiceLoadWaitTimer) {
      voiceLoadWaitTimer = setTimeout(() => {
        voiceLoadWaitTimer = null;
        voiceLoadWaitFinished = true;
        pumpSpeechQueue();
      }, remainingWait);
    }
    return true;
  }

  function pumpSpeechQueue() {
    if (!settings.enabled || activeUtterance || !speechQueue.length) return;

    let speechText = "";
    while (speechQueue.length && !speechText) {
      speechText = prepareSpeechText(speechQueue[0]);
      if (!speechText) speechQueue.shift();
    }
    if (!speechText || shouldWaitForRequestedVoice()) return;

    const backlogDepth = speechQueue.length;
    speechQueue.shift();
    const utterance = createUtterance(speechText, backlogDepth);
    const generation = speechGeneration;
    activeUtterance = utterance;

    const finish = () => {
      // cancel() may emit a late "end" or "error" event.  Ignore that stale
      // callback so it cannot consume an item from the new queue.
      if (generation !== speechGeneration || activeUtterance !== utterance) return;
      activeUtterance = null;
      // If a fragment is still inside the coalescing window, let its timer merge
      // it into the queued phrase before starting the next utterance.
      if (
        !pendingSpeechText ||
        pendingTailHasQueuedStablePrefix ||
        pendingSpeechStartsNewEntry
      ) {
        pumpSpeechQueue();
      }
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    try {
      speechSynthesis.speak(utterance);
    } catch {
      finish();
    }
  }

  function splitStableSpeechPrefix(text) {
    if (!text) return { stableText: "", trailingText: "" };

    const lastBoundary = text.lastIndexOf(" ");
    if (lastBoundary < 0) {
      return { stableText: "", trailingText: text };
    }

    return {
      stableText: normalize(text.slice(0, lastBoundary)),
      trailingText: normalize(text.slice(lastBoundary + 1))
    };
  }

  function flushSpeechBuffer(includeTrailingToken = true) {
    if (captionMutationPending) {
      if (includeTrailingToken) {
        if (speechBatchTimer) clearTimeout(speechBatchTimer);
        speechBatchTimer = setTimeout(
          () => flushSpeechBuffer(true),
          CAPTION_SETTLE_MS
        );
      } else {
        if (speechBatchDeadlineTimer) clearTimeout(speechBatchDeadlineTimer);
        speechBatchDeadlineTimer = setTimeout(
          () => flushSpeechBuffer(false),
          CAPTION_SETTLE_MS
        );
      }
      return;
    }

    // A hard prefix deadline must not restart the quiet timer. If the last
    // caption mutation is already close to becoming stable, keep that original
    // timer so it can flush the final token on time.
    if (includeTrailingToken && speechBatchTimer) {
      clearTimeout(speechBatchTimer);
      speechBatchTimer = null;
    }
    if (speechBatchDeadlineTimer) clearTimeout(speechBatchDeadlineTimer);
    speechBatchDeadlineTimer = null;

    if (!pendingSpeechText) return;

    const split = includeTrailingToken
      ? { stableText: pendingSpeechText, trailingText: "" }
      : splitStableSpeechPrefix(pendingSpeechText);
    const textToQueue = split.stableText;
    const attachToPrevious = pendingSpeechAttachesToPrevious;
    const startsNewEntry = pendingSpeechStartsNewEntry;
    const retainedTrailingText = Boolean(split.trailingText);

    pendingSpeechText = split.trailingText;

    if (!textToQueue) {
      // The deadline found only an unfinished token. Keep its relationship to
      // the preceding queued text so later character deltas still join without
      // an artificial space.
      pendingSpeechAttachesToPrevious = attachToPrevious;
      pendingSpeechStartsNewEntry = startsNewEntry;
      pendingTailHasQueuedStablePrefix =
        pendingTailHasQueuedStablePrefix ||
        (speechQueue.length > 0 && !attachToPrevious);
      if (pendingTailHasQueuedStablePrefix) pumpSpeechQueue();
      if (!speechBatchTimer) {
        speechBatchTimer = setTimeout(
          () => flushSpeechBuffer(true),
          SPEECH_BATCH_SETTLE_MS
        );
      }
      scheduleSpeechBatchDeadline();
      return;
    }

    pendingSpeechAttachesToPrevious = false;
    pendingSpeechStartsNewEntry = false;
    pendingTailHasQueuedStablePrefix = retainedTrailingText;

    if (speechQueue.length && !startsNewEntry) {
      const lastIndex = speechQueue.length - 1;
      speechQueue[lastIndex] = appendSpeechText(
        speechQueue[lastIndex],
        textToQueue,
        attachToPrevious
      );
    } else {
      speechQueue.push(textToQueue);
    }

    pumpSpeechQueue();
    if (pendingSpeechText) {
      if (!speechBatchTimer) {
        speechBatchTimer = setTimeout(
          () => flushSpeechBuffer(true),
          SPEECH_BATCH_SETTLE_MS
        );
      }
      scheduleSpeechBatchDeadline();
    } else if (speechBatchTimer) {
      clearTimeout(speechBatchTimer);
      speechBatchTimer = null;
    }
  }

  function scheduleSpeechBatchDeadline() {
    // Continuous captions still need bounded latency, but the hard deadline
    // flushes only complete-word prefixes. A trailing draft token keeps the
    // ordinary settle window instead of being forced out mid-update.
    if (!speechBatchDeadlineTimer) {
      speechBatchDeadlineTimer = setTimeout(
        () => flushSpeechBuffer(false),
        SPEECH_BATCH_MAX_WAIT_MS
      );
    }
  }

  function scheduleSpeechBufferFlush() {
    if (speechBatchTimer) clearTimeout(speechBatchTimer);
    speechBatchTimer = setTimeout(
      () => flushSpeechBuffer(true),
      SPEECH_BATCH_SETTLE_MS
    );
    scheduleSpeechBatchDeadline();
  }

  function postponeSpeechSettleForCaptionMutation() {
    if (!pendingSpeechText || !speechBatchTimer) return;
    clearTimeout(speechBatchTimer);
    speechBatchTimer = setTimeout(
      () => flushSpeechBuffer(true),
      CAPTION_SETTLE_MS + SPEECH_BATCH_SETTLE_MS
    );
  }

  function enqueueSpeech(
    text,
    attachToPrevious = false,
    startsNewEntry = false
  ) {
    const addition = normalize(text);
    if (!settings.enabled || !addition) return;

    if (startsNewEntry && pendingSpeechText) flushSpeechBuffer();

    if (!pendingSpeechText) {
      pendingSpeechText = addition;
      pendingSpeechAttachesToPrevious = attachToPrevious;
      pendingSpeechStartsNewEntry = startsNewEntry;
      pendingTailHasQueuedStablePrefix = false;
    } else {
      pendingSpeechText = appendSpeechText(
        pendingSpeechText,
        addition,
        attachToPrevious
      );
    }

    scheduleSpeechBufferFlush();
  }

  function clearSpeechQueue() {
    if (speechBatchTimer) clearTimeout(speechBatchTimer);
    speechBatchTimer = null;
    if (speechBatchDeadlineTimer) clearTimeout(speechBatchDeadlineTimer);
    speechBatchDeadlineTimer = null;
    pendingSpeechText = "";
    pendingSpeechAttachesToPrevious = false;
    pendingSpeechStartsNewEntry = false;
    pendingTailHasQueuedStablePrefix = false;
    captionMutationPending = false;
    speechQueue.length = 0;
    speechGeneration += 1;
    activeUtterance = null;
    if (voiceLoadWaitTimer) clearTimeout(voiceLoadWaitTimer);
    voiceLoadWaitTimer = null;
    voiceLoadWaitFinished = false;
    speechSynthesis.cancel();
  }

  function compareCommittedLine(committedText, currentText) {
    if (currentText === committedText) {
      return { addition: "", attachToPrevious: false, committedText };
    }
    if (currentText.startsWith(committedText)) {
      const rawAddition = currentText.slice(committedText.length);
      return {
        addition: normalize(rawAddition),
        attachToPrevious: rawAddition.length > 0 && !/^\s/.test(rawAddition),
        committedText: currentText
      };
    }
    if (committedText.startsWith(currentText)) {
      // A temporary shrink must not move the FIFO watermark backwards.
      return { addition: "", attachToPrevious: false, committedText };
    }
    return null;
  }

  function applyRollUpLineage(committedLines, currentCaptionSnapshot) {
    if (!committedLines.length || !currentCaptionSnapshot.lines.length) return null;

    const currentLines = currentCaptionSnapshot.lines.map((line) => line.text);
    let offset = compareCommittedLine(committedLines[0], currentLines[0]) ? 0 : -1;

    // A later committed line moving into the first visual position is another
    // roll. Search from the end because YouTube normally moves the bottom line.
    if (offset < 0) {
      for (let index = committedLines.length - 1; index > 0; index -= 1) {
        if (compareCommittedLine(committedLines[index], currentLines[0])) {
          offset = index;
          break;
        }
      }
    }

    if (offset < 0) return null;

    const baseLines = committedLines.slice(offset);
    const nextCommittedLines = [];
    let addition = "";
    let attachToPrevious = false;
    let everyVisibleLineMatched = true;

    const appendAddition = (text, attach = false) => {
      if (!text) return;
      if (!addition) {
        addition = text;
        attachToPrevious = attach;
        return;
      }
      addition = appendSpeechText(addition, text, attach);
    };

    for (let index = 0; index < currentLines.length; index += 1) {
      const currentText = currentLines[index];
      const comparison =
        index < baseLines.length
          ? compareCommittedLine(baseLines[index], currentText)
          : null;

      if (comparison) {
        nextCommittedLines.push(comparison.committedText);
        appendAddition(comparison.addition, comparison.attachToPrevious);
      } else {
        // The anchored first line proves continuity; a different later line is
        // genuinely new and becomes a new committed FIFO record.
        everyVisibleLineMatched = false;
        nextCommittedLines.push(currentText);
        appendAddition(currentText);
      }
    }

    // YouTube may hide the trailing visual line for a single render. Preserve
    // its committed watermark so restoring "C thêm" after [B, C] -> [B] queues
    // only "thêm". A real upward roll uses offset > 0 and does not retain it.
    if (
      offset === 0 &&
      everyVisibleLineMatched &&
      currentLines.length < baseLines.length
    ) {
      nextCommittedLines.push(...baseLines.slice(currentLines.length));
    }

    return {
      addition,
      attachToPrevious,
      committedLines: nextCommittedLines
    };
  }

  function startRollUpLineage(previousCaption, currentCaptionSnapshot) {
    if (previousCaption.lines.length < 2 || !currentCaptionSnapshot.lines.length) {
      return null;
    }

    const previousLines = previousCaption.lines.map((line) => line.text);
    const currentFirstLine = currentCaptionSnapshot.lines[0].text;

    // Only a later previous line can prove the initial two-line roll-up. This
    // keeps unrelated one-line cues with similar text independent.
    for (let index = previousLines.length - 1; index > 0; index -= 1) {
      if (!compareCommittedLine(previousLines[index], currentFirstLine)) continue;
      return applyRollUpLineage(previousLines.slice(index), currentCaptionSnapshot);
    }

    return null;
  }

  function captionAddition(previousCaption, currentCaptionSnapshot) {
    const previous = previousCaption.text;
    const current = currentCaptionSnapshot.text;

    if (!previous) return current;

    // A replaced DOM segment is a distinct cue.  It may legitimately repeat
    // the last words (or even all words) of the previous cue.
    if (!sharesCaptionNode(previousCaption, currentCaptionSnapshot)) return current;
    if (current === previous) return "";

    // Removing a trailing draft or an old visual line does not create speech.
    if (previous.startsWith(current)) return "";

    // The usual live-caption update grows the same string word by word (or
    // character by character).  The settle timer below makes the latter arrive
    // here as one complete word.
    if (current.startsWith(previous)) {
      return normalize(current.slice(previous.length));
    }

    // YouTube roll-up captions commonly change "một hai ba" into
    // "hai ba bốn". Keep the largest whole-word overlap and queue only "bốn".
    const previousWords = previous.split(" ");
    const currentWords = current.split(" ");
    const maximumOverlap = Math.min(previousWords.length, currentWords.length);

    for (let size = maximumOverlap; size > 0; size -= 1) {
      const previousStart = previousWords.length - size;
      let matches = true;

      for (let index = 0; index < size; index += 1) {
        if (previousWords[previousStart + index] !== currentWords[index]) {
          matches = false;
          break;
        }
      }

      if (matches) {
        const addition = currentWords.slice(size).join(" ");

        // A one-word boundary is ambiguous: "thank you" -> "you can leave"
        // may be two genuine cues.  Preserve that repeated word rather than
        // risk dropping text.  A complete shrink is still safe to ignore.
        if (!addition || size >= 2) return addition;
        return current;
      }
    }

    return current;
  }

  function captionAdditionAttachesToPrevious(
    previousCaption,
    currentCaptionSnapshot
  ) {
    if (!sharesCaptionNode(previousCaption, currentCaptionSnapshot)) return false;
    if (!currentCaptionSnapshot.text.startsWith(previousCaption.text)) return false;

    const rawAddition = currentCaptionSnapshot.text.slice(
      previousCaption.text.length
    );
    return rawAddition.length > 0 && !/^\s/.test(rawAddition);
  }

  function isTransientSameLineShrink(previousCaption, currentCaptionSnapshot) {
    if (
      previousCaption.lines.length !== currentCaptionSnapshot.lines.length ||
      !sharesCaptionNode(previousCaption, currentCaptionSnapshot)
    ) {
      return false;
    }

    return previousCaption.lines.every((previousLine, index) => {
      const currentLine = currentCaptionSnapshot.lines[index];
      return (
        previousLine.node === currentLine.node &&
        previousLine.text.startsWith(currentLine.text)
      );
    });
  }

  function foldVietnameseWord(word) {
    return word
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .replace(/[đĐ]/gu, "d")
      .toLocaleLowerCase("vi");
  }

  function areLikelyWordVariants(previousWord, currentWord) {
    const previousLetters = Array.from(foldVietnameseWord(previousWord));
    const currentLetters = Array.from(foldVietnameseWord(currentWord));
    if (!previousLetters.length || !currentLetters.length) return false;
    if (previousLetters.join("") === currentLetters.join("")) return true;

    const requiredPrefix = Math.min(
      2,
      previousLetters.length,
      currentLetters.length
    );
    let sharedPrefix = 0;
    while (
      sharedPrefix < previousLetters.length &&
      sharedPrefix < currentLetters.length &&
      previousLetters[sharedPrefix] === currentLetters[sharedPrefix]
    ) {
      sharedPrefix += 1;
    }
    return sharedPrefix >= requiredPrefix;
  }

  function isLikelyTrailingWordCorrection(previousText, currentText) {
    if (
      previousText !== currentText &&
      foldVietnameseWord(previousText) === foldVietnameseWord(currentText)
    ) {
      return true;
    }

    const previousWords = previousText.split(" ");
    const currentWords = currentText.split(" ");
    if (
      previousWords.length !== currentWords.length ||
      previousWords.length === 0
    ) {
      return false;
    }

    const lastIndex = previousWords.length - 1;
    for (let index = 0; index < lastIndex; index += 1) {
      if (previousWords[index] !== currentWords[index]) return false;
    }
    if (previousWords[lastIndex] === currentWords[lastIndex]) return false;

    // Require the changed word itself to be a close spelling/diacritic variant.
    // This distinguishes "học" -> "họp" from a real update such as
    // "tôi chọn A" -> "tôi chọn B".
    return areLikelyWordVariants(
      previousWords[lastIndex],
      currentWords[lastIndex]
    );
  }

  function replacePendingDraftCorrection(previousText, currentText) {
    if (
      !pendingSpeechText ||
      !isLikelyTrailingWordCorrection(previousText, currentText) ||
      !previousText.endsWith(pendingSpeechText)
    ) {
      return false;
    }

    const stablePrefix = previousText.slice(
      0,
      previousText.length - pendingSpeechText.length
    );
    if (!currentText.startsWith(stablePrefix)) return false;

    const replacement = normalize(currentText.slice(stablePrefix.length));
    if (!replacement) return false;

    pendingSpeechText = replacement;
    if (stablePrefix) {
      pendingSpeechAttachesToPrevious = !/\s$/u.test(stablePrefix);
    }
    scheduleSpeechBufferFlush();
    return true;
  }

  function processCaption(caption) {
    let lineageResult = rollUpLineage
      ? applyRollUpLineage(rollUpLineage, caption)
      : null;

    if (!lineageResult) {
      rollUpLineage = null;
      lineageResult = startRollUpLineage(displayedCaption, caption);
    }

    if (lineageResult) {
      rollUpLineage = lineageResult.committedLines;
      displayedCaption = caption;
      recordTranscriptAddition(
        lineageResult.addition,
        lineageResult.attachToPrevious
      );
      enqueueSpeech(
        lineageResult.addition,
        lineageResult.attachToPrevious
      );
      return;
    }

    const sharesCurrentCaptionNode = sharesCaptionNode(
      displayedCaption,
      caption
    );
    const transcriptCorrectionHandled =
      sharesCurrentCaptionNode &&
      replaceTranscriptCaptionRevision(
        displayedCaption.text,
        caption.text
      );
    if (
      sharesCurrentCaptionNode &&
      replacePendingDraftCorrection(displayedCaption.text, caption.text)
    ) {
      displayedCaption = caption;
      return;
    }

    const startsNewEntry =
      Boolean(displayedCaption.text) &&
      !sharesCaptionNode(displayedCaption, caption);
    const addition = captionAddition(displayedCaption, caption);
    const attachToPrevious = captionAdditionAttachesToPrevious(
      displayedCaption,
      caption
    );
    // displayedCaption is also the committed FIFO watermark.  Do not move it
    // backwards when YouTube temporarily shortens the same visual line, or the
    // restored suffix would be queued and spoken a second time.
    if (!isTransientSameLineShrink(displayedCaption, caption)) {
      displayedCaption = caption;
    }
    if (!transcriptCorrectionHandled) {
      recordTranscriptAddition(addition, attachToPrevious, startsNewEntry);
    }
    enqueueSpeech(addition, attachToPrevious, startsNewEntry);
  }

  function flushScheduledCaption() {
    if (captionTimer) clearTimeout(captionTimer);
    captionTimer = null;
    if (captionDeadlineTimer) clearTimeout(captionDeadlineTimer);
    captionDeadlineTimer = null;

    if (!scheduledCaption) return;
    const caption = scheduledCaption;
    scheduledCaption = null;
    captionMutationPending = false;
    processCaption(caption);
  }

  function scheduleCaption(caption) {
    if (captionTimer) clearTimeout(captionTimer);
    scheduledCaption = caption;
    captionTimer = setTimeout(flushScheduledCaption, CAPTION_SETTLE_MS);

    // A continuously growing live caption can mutate faster than the settle
    // window.  This non-resetting deadline guarantees regular FIFO commits.
    if (!captionDeadlineTimer) {
      captionDeadlineTimer = setTimeout(flushScheduledCaption, CAPTION_MAX_WAIT_MS);
    }
  }

  function inspectCaption() {
    const caption = currentCaption();
    const previousObservation = observedCaption;
    observedCaption = caption;

    if (
      previousObservation.text &&
      caption.text &&
      previousObservation.text !== caption.text &&
      sharesCaptionNode(previousObservation, caption)
    ) {
      // MutationObserver sees the new draft before the caption debounce commits
      // it. Postpone the speech tail immediately so the old prefix cannot start
      // in that gap and split one Vietnamese word into two utterances.
      captionMutationPending = true;
      postponeSpeechSettleForCaptionMutation();
    }

    // The observer watches the whole page, so most mutations do not change the
    // same caption.  DOM identity distinguishes a repeated new cue from a
    // redundant mutation of the current cue.
    if (sameCaptionObservation(previousObservation, caption)) {
      // Keep the newest node set when YouTube reflows only part of a multi-node
      // caption.  This preserves continuity if the older nodes disappear next.
      if (
        scheduledCaption &&
        scheduledCaption.text === caption.text &&
        sharesCaptionNode(scheduledCaption, caption)
      ) {
        scheduledCaption = caption;
      }
      if (
        displayedCaption.text === caption.text &&
        sharesCaptionNode(displayedCaption, caption)
      ) {
        displayedCaption = caption;
      }
      return;
    }

    if (!caption.text) {
      // Do not lose a short caption that disappeared before the settle timer.
      flushScheduledCaption();
      flushSpeechBuffer();
      // A later identical sentence is a new caption and must be read again.
      displayedCaption = { text: "", nodes: [], lines: [] };
      rollUpLineage = null;
      if (transcriptSession.recording && transcriptSession.entries.length) {
        transcriptSession.entryBoundaryPending = true;
      }
      return;
    }

    if (scheduledCaption) {
      const sameGrowingCaption =
        sharesCaptionNode(scheduledCaption, caption) &&
        caption.text.startsWith(scheduledCaption.text);

      if (sameGrowingCaption) {
        // Replace a character-by-character draft with its latest complete form.
        scheduleCaption(caption);
        return;
      }

      // A distinct caption arrived inside the settle window.  Commit the older
      // snapshot first so no text is overwritten or skipped.
      flushScheduledCaption();
    }

    scheduleCaption(caption);
  }

  function observe() {
    if (!document.body || observer) return;

    observer = new MutationObserver(inspectCaption);
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });
    inspectCaption();
  }

  function startWhenReady() {
    if (document.body) {
      observe();
      return;
    }
    new MutationObserver((_, waitingObserver) => {
      if (!document.body) return;
      waitingObserver.disconnect();
      observe();
    }).observe(document.documentElement, { childList: true });
  }

  chrome.storage.sync.get(DEFAULTS, (saved) => {
    settings = { ...DEFAULTS, ...saved };

    const previousRate = Number(settings.rate);
    settings.rate =
      settings.ttsSettingsVersion < TTS_SETTINGS_VERSION &&
      previousRate === LEGACY_DEFAULT_RATE
        ? DEFAULTS.rate
        : normalizedSpeechRate(previousRate);

    // Migrate only the old 1.35x default. Preserve a user's custom rate and
    // voice; selectedVoice() safely ignores a saved non-Vietnamese voice.
    if (settings.ttsSettingsVersion < TTS_SETTINGS_VERSION) {
      settings.ttsSettingsVersion = TTS_SETTINGS_VERSION;
      chrome.storage.sync.set({
        rate: settings.rate,
        ttsSettingsVersion: settings.ttsSettingsVersion
      });
    }

    startWhenReady();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;

    const wasEnabled = settings.enabled;
    const voiceSettingChanged = Object.prototype.hasOwnProperty.call(
      changes,
      "voiceURI"
    );
    for (const [key, change] of Object.entries(changes)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        settings[key] = change.newValue;
      }
    }

    if (voiceSettingChanged) {
      if (voiceLoadWaitTimer) clearTimeout(voiceLoadWaitTimer);
      voiceLoadWaitTimer = null;
      voiceLoadWaitFinished = false;
    }

    if (!settings.enabled) {
      clearSpeechQueue();
    } else if (!wasEnabled) {
      // Enabling mid-caption should read the currently visible text once.
      observedCaption = { text: "", nodes: [], lines: [] };
      displayedCaption = { text: "", nodes: [], lines: [] };
      scheduledCaption = null;
      rollUpLineage = null;
      inspectCaption();
    } else if (voiceSettingChanged) {
      pumpSpeechQueue();
    }
  });

  if (
    chrome.runtime &&
    chrome.runtime.onMessage &&
    typeof chrome.runtime.onMessage.addListener === "function"
  ) {
    chrome.runtime.onMessage.addListener(handleTranscriptMessage);
  }

  if (typeof speechSynthesis.addEventListener === "function") {
    speechSynthesis.addEventListener("voiceschanged", () => {
      if (!voiceLoadWaitTimer || !configuredVoice()) return;
      clearTimeout(voiceLoadWaitTimer);
      voiceLoadWaitTimer = null;
      voiceLoadWaitFinished = true;
      pumpSpeechQueue();
    });
  }
  // Start loading the browser/system voice list at document_start so the first
  // visible caption normally pays no additional voice-discovery delay.
  speechSynthesis.getVoices();
})();
