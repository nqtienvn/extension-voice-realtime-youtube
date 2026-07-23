const TTS_SETTINGS_VERSION = 1;
const LEGACY_DEFAULT_RATE = 1.35;
const MIN_SPEECH_RATE = 0.75;
const MAX_SPEECH_RATE = 3;
const VIETNAMESE_LANG = "vi-VN";
const DEFAULTS = {
  enabled: true,
  rate: 1,
  voiceURI: "",
  ttsSettingsVersion: 0
};
const TRANSCRIPT_MESSAGES = Object.freeze({
  GET_STATE: "transcript:getState",
  START: "transcript:start",
  STOP: "transcript:stop",
  EXPORT: "transcript:export"
});

const enabled = document.querySelector("#enabled");
const rate = document.querySelector("#rate");
const rateValue = document.querySelector("#rateValue");
const voice = document.querySelector("#voice");
const voiceHint = document.querySelector("#voiceHint");
const transcriptStatus = document.querySelector("#transcriptStatus");
const transcriptButton = document.querySelector("#transcriptButton");
const transcriptDownload = document.querySelector("#transcriptDownload");
let preferredVoiceURI = "";
let transcriptConnected = false;
let transcriptBusy = true;
let transcriptError = "";
let transcriptPollTimer = null;
let activeTranscriptState = {
  recording: false,
  hasContent: false,
  entryCount: 0,
  wordCount: 0,
  stoppedBecauseVideoChanged: false
};

function showRate() {
  rateValue.value = `${Number(rate.value).toFixed(2)}×`;
}

function normalizedSpeechRate(value) {
  const numericRate = Number(value);
  if (!Number.isFinite(numericRate)) return DEFAULTS.rate;
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, numericRate));
}

function saveGeneralSettings() {
  chrome.storage.sync.set({
    enabled: enabled.checked,
    rate: normalizedSpeechRate(rate.value),
    ttsSettingsVersion: TTS_SETTINGS_VERSION
  });
}

function saveVoiceSetting() {
  preferredVoiceURI = voice.value;
  chrome.storage.sync.set({
    voiceURI: preferredVoiceURI,
    ttsSettingsVersion: TTS_SETTINGS_VERSION
  });
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

function isVietnameseVoice(item) {
  return /^vi(?:-|$)/i.test(canonicalLanguageTag(item.lang));
}

function voiceScore(item) {
  return (
    (canonicalLanguageTag(item.lang).toLowerCase() ===
    VIETNAMESE_LANG.toLowerCase()
      ? 4
      : 0) +
    (item.default ? 2 : 0) +
    (item.localService ? 1 : 0)
  );
}

function populateVoices() {
  while (voice.options.length > 1) voice.remove(1);

  const voices = speechSynthesis
    .getVoices()
    .filter(isVietnameseVoice)
    .sort(
      (first, second) =>
        voiceScore(second) - voiceScore(first) ||
        first.name.localeCompare(second.name)
    );

  for (const item of voices) {
    const option = document.createElement("option");
    option.value = item.voiceURI;
    option.textContent = `${item.name} (${item.lang})${item.localService ? "" : " — mạng"}`;
    voice.append(option);
  }

  voice.value = voices.some((item) => item.voiceURI === preferredVoiceURI)
    ? preferredVoiceURI
    : "";
  voiceHint.textContent = voices.length
    ? `Đã tìm thấy ${voices.length} giọng tiếng Việt.`
      : "Không tìm thấy giọng tiếng Việt; hãy cài giọng Vietnamese (vi-VN) trong hệ điều hành.";
}

function renderTranscriptState() {
  transcriptButton.disabled = !transcriptConnected || transcriptBusy;
  transcriptDownload.disabled =
    !transcriptConnected ||
    transcriptBusy ||
    !activeTranscriptState.hasContent;

  if (transcriptError) {
    transcriptStatus.dataset.state = "error";
    transcriptStatus.textContent = transcriptError;
    return;
  }
  if (transcriptBusy) {
    transcriptStatus.dataset.state = "busy";
    transcriptStatus.textContent = "Đang kết nối với video…";
    return;
  }

  const details = `${activeTranscriptState.entryCount} đoạn • ${activeTranscriptState.wordCount} từ`;
  if (activeTranscriptState.recording) {
    transcriptStatus.dataset.state = "recording";
    transcriptStatus.textContent = `Đang ghi • ${details}`;
    transcriptButton.textContent = "Dừng & tải TXT";
    return;
  }

  transcriptStatus.dataset.state = "idle";
  if (activeTranscriptState.stoppedBecauseVideoChanged) {
    transcriptStatus.textContent = `Video đã đổi; bản ghi cũ đã dừng • ${details}`;
    transcriptButton.textContent = "Tải cũ & ghi video mới";
  } else if (activeTranscriptState.hasContent) {
    transcriptStatus.textContent = `Đã dừng • ${details}`;
    transcriptButton.textContent = "Tiếp tục ghi";
  } else {
    transcriptStatus.textContent = "Chưa ghi phụ đề.";
    transcriptButton.textContent = "Bắt đầu ghi";
  }
}

function transcriptMessageError(fallback) {
  const error = chrome.runtime && chrome.runtime.lastError;
  return error && error.message ? error.message : fallback;
}

function sendTranscriptMessage(message, callback) {
  if (!chrome.tabs || typeof chrome.tabs.query !== "function") {
    callback({
      ok: false,
      connectionError: true,
      error: "Trình duyệt không hỗ trợ kết nối với tab hiện tại."
    });
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const queryError = transcriptMessageError("");
    if (queryError) {
      callback({ ok: false, connectionError: true, error: queryError });
      return;
    }

    const tab = tabs && tabs[0];
    if (!tab || !Number.isInteger(tab.id)) {
      callback({
        ok: false,
        connectionError: true,
        error: "Không tìm thấy tab YouTube đang mở."
      });
      return;
    }

    chrome.tabs.sendMessage(tab.id, message, (response) => {
      const sendError = transcriptMessageError("");
      if (sendError) {
        callback({
          ok: false,
          connectionError: true,
          error: "Hãy mở hoặc tải lại một video YouTube rồi thử lại."
        });
        return;
      }
      callback(
        response && typeof response === "object"
          ? response
          : {
              ok: false,
              connectionError: true,
              error: "Tab YouTube không phản hồi."
            }
      );
    });
  });
}

function applyTranscriptResponse(response) {
  if (!response || !response.ok || !response.state) {
    if (!response || response.connectionError) {
      transcriptConnected = false;
    }
    transcriptError =
      (response && response.error) ||
      "Không thể kết nối với phụ đề của tab hiện tại.";
    return false;
  }

  transcriptConnected = true;
  transcriptError = "";
  activeTranscriptState = {
    ...activeTranscriptState,
    ...response.state
  };
  return true;
}

function updateTranscriptPolling() {
  const shouldPoll =
    transcriptConnected && activeTranscriptState.recording;
  if (shouldPoll && !transcriptPollTimer) {
    transcriptPollTimer = setInterval(() => {
      if (transcriptBusy) return;
      sendTranscriptMessage(
        { type: TRANSCRIPT_MESSAGES.GET_STATE },
        (response) => {
          applyTranscriptResponse(response);
          renderTranscriptState();
          updateTranscriptPolling();
        }
      );
    }, 1000);
  } else if (!shouldPoll && transcriptPollTimer) {
    clearInterval(transcriptPollTimer);
    transcriptPollTimer = null;
  }
}

function refreshTranscriptState() {
  transcriptBusy = true;
  renderTranscriptState();
  sendTranscriptMessage({ type: TRANSCRIPT_MESSAGES.GET_STATE }, (response) => {
    transcriptBusy = false;
    applyTranscriptResponse(response);
    renderTranscriptState();
    updateTranscriptPolling();
  });
}

function triggerTranscriptDownload(response) {
  const blob = new Blob(["\uFEFF", response.content], {
    type: "text/plain;charset=utf-8"
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = response.filename;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function downloadTranscript(done = () => {}) {
  sendTranscriptMessage({ type: TRANSCRIPT_MESSAGES.EXPORT }, (response) => {
    if (!response || !response.ok) {
      if (!response || response.connectionError) {
        transcriptConnected = false;
      }
      transcriptError =
        (response && response.error) || "Không thể tạo tệp phụ đề.";
      done(false);
      return;
    }

    if (response.state) {
      applyTranscriptResponse({ ok: true, state: response.state });
    }
    triggerTranscriptDownload(response);
    done(true);
  });
}

function toggleTranscriptRecording() {
  if (!transcriptConnected || transcriptBusy) return;
  transcriptBusy = true;
  renderTranscriptState();

  if (activeTranscriptState.recording) {
    sendTranscriptMessage({ type: TRANSCRIPT_MESSAGES.STOP }, (response) => {
      if (!applyTranscriptResponse(response)) {
        transcriptBusy = false;
        renderTranscriptState();
        updateTranscriptPolling();
        return;
      }
      updateTranscriptPolling();
      if (!activeTranscriptState.hasContent) {
        transcriptBusy = false;
        renderTranscriptState();
        return;
      }
      downloadTranscript(() => {
        transcriptBusy = false;
        renderTranscriptState();
        updateTranscriptPolling();
      });
    });
    return;
  }

  if (
    activeTranscriptState.stoppedBecauseVideoChanged &&
    activeTranscriptState.hasContent
  ) {
    downloadTranscript((downloaded) => {
      if (!downloaded) {
        transcriptBusy = false;
        renderTranscriptState();
        updateTranscriptPolling();
        return;
      }
      sendTranscriptMessage(
        { type: TRANSCRIPT_MESSAGES.START, reset: true },
        (response) => {
          transcriptBusy = false;
          applyTranscriptResponse(response);
          renderTranscriptState();
          updateTranscriptPolling();
        }
      );
    });
    return;
  }

  sendTranscriptMessage(
    {
      type: TRANSCRIPT_MESSAGES.START,
      reset: false
    },
    (response) => {
      transcriptBusy = false;
      applyTranscriptResponse(response);
      renderTranscriptState();
      updateTranscriptPolling();
    }
  );
}

function downloadCurrentTranscript() {
  if (
    !transcriptConnected ||
    transcriptBusy ||
    !activeTranscriptState.hasContent
  ) {
    return;
  }
  transcriptBusy = true;
  renderTranscriptState();
  downloadTranscript(() => {
    transcriptBusy = false;
    renderTranscriptState();
    updateTranscriptPolling();
  });
}

chrome.storage.sync.get(DEFAULTS, (settings) => {
  const previousRate = Number(settings.rate);
  settings.rate =
    settings.ttsSettingsVersion < TTS_SETTINGS_VERSION &&
    previousRate === LEGACY_DEFAULT_RATE
      ? DEFAULTS.rate
      : normalizedSpeechRate(previousRate);

  if (settings.ttsSettingsVersion < TTS_SETTINGS_VERSION) {
    settings.ttsSettingsVersion = TTS_SETTINGS_VERSION;
    chrome.storage.sync.set({
      rate: settings.rate,
      ttsSettingsVersion: settings.ttsSettingsVersion
    });
  }

  preferredVoiceURI = settings.voiceURI;
  enabled.checked = settings.enabled;
  rate.value = settings.rate;
  showRate();
  populateVoices();
});

// Some Chromium builds load the list asynchronously.
speechSynthesis.addEventListener("voiceschanged", () => {
  populateVoices();
});

enabled.addEventListener("change", saveGeneralSettings);
rate.addEventListener("input", () => {
  showRate();
  saveGeneralSettings();
});
voice.addEventListener("change", saveVoiceSetting);
transcriptButton.addEventListener("click", toggleTranscriptRecording);
transcriptDownload.addEventListener("click", downloadCurrentTranscript);
refreshTranscriptState();
