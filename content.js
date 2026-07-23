/*
 * Runs in YouTube's tab.  Keeping TTS here avoids a background/service-worker
 * round trip and avoids any network call: this is the shortest path available
 * to a local Chrome/system voice.
 */
(() => {
  const DEFAULTS = {
    enabled: true,
    rate: 1.35,
    pitch: 1,
    volume: 1,
    voiceURI: ""
  };
  const CAPTION_SETTLE_MS = 80;
  const CAPTION_MAX_WAIT_MS = 250;
  const SPEECH_BATCH_SETTLE_MS = 320;
  const SPEECH_BATCH_MAX_WAIT_MS = 900;

  let settings = { ...DEFAULTS };
  let displayedCaption = { text: "", nodes: [], lines: [] };
  let observedCaption = { text: "", nodes: [], lines: [] };
  let scheduledCaption = null;
  let captionTimer = null;
  let captionDeadlineTimer = null;
  const speechQueue = [];
  let activeUtterance = null;
  let speechGeneration = 0;
  let pendingSpeechText = "";
  let pendingSpeechAttachesToPrevious = false;
  let pendingSpeechStartsNewEntry = false;
  let speechBatchTimer = null;
  let speechBatchDeadlineTimer = null;
  let rollUpLineage = null;
  let observer = null;

  function normalize(text) {
    return text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
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

  function sharesCaptionNode(first, second) {
    if (!first.nodes.length || !second.nodes.length) return false;
    return first.nodes.some((node) => second.nodes.includes(node));
  }

  function sameCaptionObservation(first, second) {
    if (first.text !== second.text) return false;
    if (!first.text) return true;
    return sharesCaptionNode(first, second);
  }

  function selectedVoice() {
    if (!settings.voiceURI) return null;
    return speechSynthesis.getVoices().find((voice) => voice.voiceURI === settings.voiceURI) || null;
  }

  function createUtterance(text) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = Number(settings.rate);
    utterance.pitch = Number(settings.pitch);
    utterance.volume = Number(settings.volume);
    utterance.lang = document.documentElement.lang || navigator.language;

    const voice = selectedVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }

    return utterance;
  }

  function pumpSpeechQueue() {
    if (!settings.enabled || activeUtterance || !speechQueue.length) return;

    const utterance = createUtterance(speechQueue.shift());
    const generation = speechGeneration;
    activeUtterance = utterance;

    const finish = () => {
      // cancel() may emit a late "end" or "error" event.  Ignore that stale
      // callback so it cannot consume an item from the new queue.
      if (generation !== speechGeneration || activeUtterance !== utterance) return;
      activeUtterance = null;
      // If a fragment is still inside the coalescing window, let its timer merge
      // it into the queued phrase before starting the next utterance.
      if (!pendingSpeechText) pumpSpeechQueue();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    try {
      speechSynthesis.speak(utterance);
    } catch {
      finish();
    }
  }

  function flushSpeechBuffer() {
    if (speechBatchTimer) clearTimeout(speechBatchTimer);
    speechBatchTimer = null;
    if (speechBatchDeadlineTimer) clearTimeout(speechBatchDeadlineTimer);
    speechBatchDeadlineTimer = null;

    if (!pendingSpeechText) return;

    if (speechQueue.length && !pendingSpeechStartsNewEntry) {
      const lastIndex = speechQueue.length - 1;
      speechQueue[lastIndex] = appendSpeechText(
        speechQueue[lastIndex],
        pendingSpeechText,
        pendingSpeechAttachesToPrevious
      );
    } else {
      speechQueue.push(pendingSpeechText);
    }

    pendingSpeechText = "";
    pendingSpeechAttachesToPrevious = false;
    pendingSpeechStartsNewEntry = false;
    pumpSpeechQueue();
  }

  function scheduleSpeechBufferFlush() {
    if (speechBatchTimer) clearTimeout(speechBatchTimer);
    speechBatchTimer = setTimeout(flushSpeechBuffer, SPEECH_BATCH_SETTLE_MS);

    // Continuous captions still need bounded latency, but the larger deadline
    // lets several nearby words become one intelligible utterance.
    if (!speechBatchDeadlineTimer) {
      speechBatchDeadlineTimer = setTimeout(
        flushSpeechBuffer,
        SPEECH_BATCH_MAX_WAIT_MS
      );
    }
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
    speechQueue.length = 0;
    speechGeneration += 1;
    activeUtterance = null;
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
      enqueueSpeech(
        lineageResult.addition,
        lineageResult.attachToPrevious
      );
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
    startWhenReady();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;

    const wasEnabled = settings.enabled;
    for (const [key, change] of Object.entries(changes)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        settings[key] = change.newValue;
      }
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
    }
  });
})();
