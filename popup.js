const DEFAULTS = {
  enabled: true,
  rate: 1.35,
  voiceURI: ""
};

const enabled = document.querySelector("#enabled");
const rate = document.querySelector("#rate");
const rateValue = document.querySelector("#rateValue");
const voice = document.querySelector("#voice");

function showRate() {
  rateValue.value = `${Number(rate.value).toFixed(2)}×`;
}

function save() {
  chrome.storage.sync.set({
    enabled: enabled.checked,
    rate: Number(rate.value),
    voiceURI: voice.value
  });
}

function populateVoices(activeVoiceURI) {
  const voices = speechSynthesis.getVoices().sort((a, b) => a.name.localeCompare(b.name));
  for (const item of voices) {
    const option = document.createElement("option");
    option.value = item.voiceURI;
    option.textContent = `${item.name} (${item.lang})${item.localService ? "" : " — mạng"}`;
    voice.append(option);
  }
  voice.value = activeVoiceURI;
}

chrome.storage.sync.get(DEFAULTS, (settings) => {
  enabled.checked = settings.enabled;
  rate.value = settings.rate;
  showRate();
  populateVoices(settings.voiceURI);
});

// Some Chromium builds load the list asynchronously.
speechSynthesis.addEventListener("voiceschanged", () => {
  const selected = voice.value;
  if (voice.options.length === 1) populateVoices(selected);
});

enabled.addEventListener("change", save);
rate.addEventListener("input", () => {
  showRate();
  save();
});
voice.addEventListener("change", save);
