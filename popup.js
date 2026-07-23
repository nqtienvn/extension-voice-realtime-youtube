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

const enabled = document.querySelector("#enabled");
const rate = document.querySelector("#rate");
const rateValue = document.querySelector("#rateValue");
const voice = document.querySelector("#voice");
const voiceHint = document.querySelector("#voiceHint");
let preferredVoiceURI = "";

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
