const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const POPUP_SCRIPT = fs.readFileSync(
  path.join(__dirname, "..", "popup.js"),
  "utf8"
);
const POPUP_HTML = fs.readFileSync(
  path.join(__dirname, "..", "popup.html"),
  "utf8"
);

function createElement(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(event, listener) {
      const eventListeners = listeners.get(event) || [];
      eventListeners.push(listener);
      listeners.set(event, eventListeners);
    },
    dispatch(event) {
      for (const listener of listeners.get(event) || []) listener();
    }
  };
}

function createHarness(savedSettings = {}, availableVoices = []) {
  let voices = [...availableVoices];
  const voiceListeners = [];
  const storageWrites = [];
  const persistedSettings = { ...savedSettings };

  const enabled = createElement({ checked: false });
  const rate = createElement({ value: "" });
  const rateValue = createElement({ value: "" });
  const voice = createElement({
    value: "",
    options: [{ value: "", textContent: "Tự động" }],
    append(option) {
      this.options.push(option);
    },
    remove(index) {
      this.options.splice(index, 1);
    }
  });
  const voiceHint = createElement({ textContent: "" });
  const elements = {
    "#enabled": enabled,
    "#rate": rate,
    "#rateValue": rateValue,
    "#voice": voice,
    "#voiceHint": voiceHint
  };

  const document = {
    querySelector(selector) {
      return elements[selector];
    },
    createElement() {
      return { value: "", textContent: "" };
    }
  };
  const chrome = {
    storage: {
      sync: {
        get(defaults, callback) {
          callback({ ...defaults, ...persistedSettings });
        },
        set(values) {
          storageWrites.push({ ...values });
          Object.assign(persistedSettings, values);
        }
      }
    }
  };
  const speechSynthesis = {
    getVoices() {
      return voices;
    },
    addEventListener(event, listener) {
      if (event === "voiceschanged") voiceListeners.push(listener);
    }
  };

  vm.runInNewContext(POPUP_SCRIPT, {
    chrome,
    document,
    Intl,
    speechSynthesis
  });

  return {
    enabled,
    rate,
    rateValue,
    voice,
    voiceHint,
    storageWrites,
    get persistedSettings() {
      return { ...persistedSettings };
    },
    setVoices(nextVoices) {
      voices = [...nextVoices];
    },
    emitVoicesChanged() {
      for (const listener of voiceListeners) listener();
    }
  };
}

test("giữ voice đã lưu khi Chromium tải danh sách voice bất đồng bộ", () => {
  const savedVoice = {
    name: "Vietnamese",
    lang: "vi_VN",
    voiceURI: "voice-vi",
    default: true,
    localService: true
  };
  const harness = createHarness({
    rate: 1,
    voiceURI: savedVoice.voiceURI,
    ttsSettingsVersion: 1
  });

  assert.equal(harness.voice.value, "");
  harness.rate.value = "0.95";
  harness.rate.dispatch("input");
  assert.equal(harness.persistedSettings.voiceURI, savedVoice.voiceURI);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      harness.storageWrites.at(-1),
      "voiceURI"
    ),
    false
  );

  harness.setVoices([savedVoice]);
  harness.emitVoicesChanged();
  assert.equal(harness.voice.value, savedVoice.voiceURI);
});

test("popup chỉ liệt kê giọng Việt và ưu tiên vi-VN mặc định", () => {
  const harness = createHarness(
    { ttsSettingsVersion: 1 },
    [
      {
        name: "English",
        lang: "en-US",
        voiceURI: "voice-en",
        default: true,
        localService: true
      },
      {
        name: "Vietnamese generic",
        lang: "vi",
        voiceURI: "voice-vi",
        default: false,
        localService: false
      },
      {
        name: "Vietnamese Vietnam",
        lang: "vi_VN",
        voiceURI: "voice-vi-vn",
        default: true,
        localService: true
      }
    ]
  );

  assert.deepEqual(
    harness.voice.options.map((option) => option.value),
    ["", "voice-vi-vn", "voice-vi"]
  );
  assert.match(harness.voiceHint.textContent, /2 giọng tiếng Việt/);
});

test("đổi voice chỉ lưu voice và cho phép trở lại chế độ tự động", () => {
  const vietnameseVoice = {
    name: "Vietnamese",
    lang: "vi-VN",
    voiceURI: "voice-vi",
    default: true,
    localService: true
  };
  const harness = createHarness(
    { ttsSettingsVersion: 1 },
    [vietnameseVoice]
  );

  harness.voice.value = vietnameseVoice.voiceURI;
  harness.voice.dispatch("change");
  assert.deepEqual(harness.storageWrites.at(-1), {
    voiceURI: vietnameseVoice.voiceURI,
    ttsSettingsVersion: 1
  });

  harness.voice.value = "";
  harness.voice.dispatch("change");
  assert.equal(harness.persistedSettings.voiceURI, "");
});

test("migration popup giữ tốc độ tùy chỉnh và chỉ thay mặc định 1.35x cũ", () => {
  assert.match(
    POPUP_HTML,
    /<input id="rate" type="range" min="0\.75" max="3" step="0\.05" \/>/
  );

  const custom = createHarness({
    rate: 2,
    voiceURI: "voice-vi",
    ttsSettingsVersion: 0
  });
  assert.equal(custom.rate.value, 2);
  assert.equal(custom.persistedSettings.voiceURI, "voice-vi");
  assert.deepEqual(custom.storageWrites[0], {
    rate: 2,
    ttsSettingsVersion: 1
  });

  const legacy = createHarness({
    rate: 1.35,
    voiceURI: "voice-vi",
    ttsSettingsVersion: 0
  });
  assert.equal(legacy.rate.value, 1);
  assert.equal(legacy.persistedSettings.voiceURI, "voice-vi");
  assert.deepEqual(legacy.storageWrites[0], {
    rate: 1,
    ttsSettingsVersion: 1
  });
});
