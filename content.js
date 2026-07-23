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

  let settings = { ...DEFAULTS };
  let displayedCaption = { text: "", nodes: [] };
  let observedCaption = { text: "", nodes: [] };
  let scheduledCaption = null;
  let captionTimer = null;
  let captionDeadlineTimer = null;
  const speechQueue = [];
  let activeUtterance = null;
  let speechGeneration = 0;
  let observer = null;

  function normalize(text) {
    return text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  }

  function currentCaption() {
    // ytp-caption-segment is the element currently painted by the YouTube player.
    // It is deliberately read, rather than calling YouTube's transcript APIs, so
    // the spoken text exactly follows the visible subtitle.
    const segments = document.querySelectorAll(
      ".ytp-caption-window-container .ytp-caption-segment"
    );
    const nodes = Array.from(segments);
    if (!nodes.length) return { text: "", nodes };

    return {
      text: normalize(nodes.map((segment) => segment.textContent || "").join(" ")),
      nodes
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
      pumpSpeechQueue();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    try {
      speechSynthesis.speak(utterance);
    } catch {
      finish();
    }
  }

  function enqueueSpeech(text) {
    const addition = normalize(text);
    if (!settings.enabled || !addition) return;

    speechQueue.push(addition);
    pumpSpeechQueue();
  }

  function clearSpeechQueue() {
    speechQueue.length = 0;
    speechGeneration += 1;
    activeUtterance = null;
    speechSynthesis.cancel();
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

  function processCaption(caption) {
    const addition = captionAddition(displayedCaption, caption);
    displayedCaption = caption;
    enqueueSpeech(addition);
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
      // A later identical sentence is a new caption and must be read again.
      displayedCaption = { text: "", nodes: [] };
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
      observedCaption = { text: "", nodes: [] };
      displayedCaption = { text: "", nodes: [] };
      scheduledCaption = null;
      inspectCaption();
    }
  });
})();
