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
    voiceURI: "",
    interruptPrevious: true
  };

  let settings = { ...DEFAULTS };
  let displayedText = "";
  let pendingText = "";
  let flushTimer = null;
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
    if (!segments.length) return "";

    return normalize(Array.from(segments, (segment) => segment.textContent || "").join(" "));
  }

  function selectedVoice() {
    if (!settings.voiceURI) return null;
    return speechSynthesis.getVoices().find((voice) => voice.voiceURI === settings.voiceURI) || null;
  }

  function speak(text, interrupt = false) {
    if (!settings.enabled || !text) return;

    // Only a replacement caption cancels speech.  A YouTube caption often grows
    // word by word, so canceling on every mutation would restart it from zero.
    if (interrupt && settings.interruptPrevious) speechSynthesis.cancel();

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

    speechSynthesis.speak(utterance);
  }

  function enqueue(text, replace = false) {
    const addition = normalize(text);
    if (!addition) return;

    if (replace) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      pendingText = addition;
      if (settings.interruptPrevious) speechSynthesis.cancel();
    } else {
      pendingText = pendingText ? `${pendingText} ${addition}` : addition;
    }

    // Small settle window combines character-by-character DOM mutations, while
    // keeping the call to the local TTS engine within about 80 ms of the last one.
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const textToSpeak = pendingText;
        pendingText = "";
        speak(textToSpeak);
      }, 80);
    }
  }

  function inspectCaption() {
    const text = currentCaption();
    if (!text) {
      // A cleared caption makes a later identical sentence eligible to be read.
      displayedText = "";
      return;
    }

    // YouTube may mutate several nested nodes for a single visual change.
    if (text === displayedText) return;

    if (displayedText && text.startsWith(displayedText)) {
      // Example: "Xin chào" -> "Xin chào bạn". Read only "bạn" and let
      // the previous utterance finish instead of starting "Xin chào" again.
      enqueue(text.slice(displayedText.length));
    } else {
      // This is a new caption (or YouTube rewrote the current line), not an
      // extension of the one already visible.
      enqueue(text, true);
    }

    displayedText = text;
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
    for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
    if (!settings.enabled) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      pendingText = "";
      speechSynthesis.cancel();
    }
  });
})();
