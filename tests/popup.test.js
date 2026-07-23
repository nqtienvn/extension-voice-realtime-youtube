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
    dataset: {},
    disabled: false,
    style: {},
    textContent: "",
    ...initial,
    addEventListener(event, listener) {
      const eventListeners = listeners.get(event) || [];
      eventListeners.push(listener);
      listeners.set(event, eventListeners);
    },
    dispatch(event) {
      return (listeners.get(event) || []).map((listener) => listener());
    }
  };
}

function createHarness(
  savedSettings = {},
  availableVoices = [],
  transcriptOptions = {}
) {
  let voices = [...availableVoices];
  const voiceListeners = [];
  const storageWrites = [];
  const persistedSettings = { ...savedSettings };
  const sentMessages = [];
  const downloads = [];
  const blobs = [];
  const revokedObjectUrls = [];
  const intervalCallbacks = new Map();
  let runtimeError = "";
  let runtimeErrorVisible = false;
  let nextIntervalId = 1;
  let transcriptState = {
    recording: false,
    hasContent: false,
    entryCount: 0,
    wordCount: 0,
    stoppedBecauseVideoChanged: false,
    ...(transcriptOptions.initialState || {})
  };

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
  const transcriptStatus = createElement({ textContent: "" });
  const transcriptButton = createElement({ textContent: "", disabled: true });
  const transcriptDownload = createElement({
    textContent: "",
    disabled: true
  });
  const elements = {
    "#enabled": enabled,
    "#rate": rate,
    "#rateValue": rateValue,
    "#voice": voice,
    "#voiceHint": voiceHint,
    "#transcriptStatus": transcriptStatus,
    "#transcriptButton": transcriptButton,
    "#transcriptDownload": transcriptDownload
  };

  const document = {
    body: {
      append() {}
    },
    querySelector(selector) {
      return elements[selector];
    },
    createElement(tagName) {
      if (tagName === "a") {
        return {
          href: "",
          download: "",
          style: {},
          click() {
            downloads.push({
              href: this.href,
              filename: this.download
            });
          },
          remove() {}
        };
      }
      return { value: "", textContent: "" };
    }
  };

  function defaultTranscriptResponse(message) {
    if (message.type === "transcript:getState") {
      return { ok: true, state: { ...transcriptState } };
    }
    if (message.type === "transcript:start") {
      if (message.reset) {
        transcriptState = {
          recording: false,
          hasContent: false,
          entryCount: 0,
          wordCount: 0,
          stoppedBecauseVideoChanged: false
        };
      }
      transcriptState.recording = true;
      return { ok: true, state: { ...transcriptState } };
    }
    if (message.type === "transcript:stop") {
      transcriptState.recording = false;
      return { ok: true, state: { ...transcriptState } };
    }
    if (message.type === "transcript:export") {
      if (!transcriptState.hasContent) {
        return { ok: false, error: "Chưa có phụ đề nào trong bản ghi." };
      }
      return {
        ok: true,
        content: "[00:00:01] Xin chào",
        filename: "youtube-phu-de_test.txt",
        state: { ...transcriptState }
      };
    }
    return { ok: false, error: "Lệnh không hỗ trợ." };
  }

  const chrome = {
    runtime: {
      get lastError() {
        return runtimeErrorVisible && runtimeError
          ? { message: runtimeError }
          : null;
      }
    },
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
    },
    tabs: {
      query(_query, callback) {
        callback([{ id: 7 }]);
      },
      sendMessage(tabId, message, callback) {
        sentMessages.push({ tabId, message: { ...message } });
        if (runtimeError) {
          runtimeErrorVisible = true;
          callback(undefined);
          runtimeErrorVisible = false;
          return;
        }
        const responder =
          transcriptOptions.respond || defaultTranscriptResponse;
        callback(responder(message, { ...transcriptState }));
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
  class FakeBlob {
    constructor(parts, options) {
      this.parts = [...parts];
      this.type = options.type;
      blobs.push(this);
    }
  }
  const fakeUrl = {
    createObjectURL(blob) {
      return `blob:test-${blobs.indexOf(blob)}`;
    },
    revokeObjectURL(value) {
      revokedObjectUrls.push(value);
    }
  };

  vm.runInNewContext(POPUP_SCRIPT, {
    Blob: FakeBlob,
    chrome,
    clearInterval(intervalId) {
      intervalCallbacks.delete(intervalId);
    },
    document,
    Intl,
    setInterval(callback) {
      const intervalId = nextIntervalId;
      nextIntervalId += 1;
      intervalCallbacks.set(intervalId, callback);
      return intervalId;
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    speechSynthesis,
    URL: fakeUrl
  });

  return {
    enabled,
    rate,
    rateValue,
    voice,
    voiceHint,
    transcriptStatus,
    transcriptButton,
    transcriptDownload,
    storageWrites,
    sentMessages,
    downloads,
    blobs,
    revokedObjectUrls,
    get persistedSettings() {
      return { ...persistedSettings };
    },
    setVoices(nextVoices) {
      voices = [...nextVoices];
    },
    emitVoicesChanged() {
      for (const listener of voiceListeners) listener();
    },
    setTranscriptState(nextState) {
      transcriptState = { ...transcriptState, ...nextState };
    },
    runTranscriptPoll() {
      for (const callback of [...intervalCallbacks.values()]) callback();
    },
    setRuntimeError(message) {
      runtimeError = message;
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

test("popup có điều khiển ghi phụ đề và mô tả rõ phạm vi bản ghi", () => {
  assert.match(POPUP_HTML, /id="transcriptStatus" aria-live="polite"/);
  assert.match(POPUP_HTML, /id="transcriptButton"/);
  assert.match(POPUP_HTML, /id="transcriptDownload"/);
  assert.match(POPUP_HTML, /Chỉ ghi phụ đề xuất hiện từ lúc bạn bấm bắt đầu/);
});

test("popup khởi tạo đúng trạng thái phiên ghi đang chạy", () => {
  const harness = createHarness(
    {},
    [],
    {
      initialState: {
        recording: true,
        hasContent: true,
        entryCount: 3,
        wordCount: 21
      }
    }
  );

  assert.deepEqual(harness.sentMessages[0], {
    tabId: 7,
    message: { type: "transcript:getState" }
  });
  assert.equal(harness.transcriptStatus.dataset.state, "recording");
  assert.match(harness.transcriptStatus.textContent, /3 đoạn • 21 từ/);
  assert.equal(harness.transcriptButton.textContent, "Dừng & tải TXT");
  assert.equal(harness.transcriptButton.disabled, false);
  assert.equal(harness.transcriptDownload.disabled, false);
});

test("tiếp tục ghi không xóa nội dung cũ chưa tải", () => {
  const harness = createHarness(
    {},
    [],
    {
      initialState: {
        recording: false,
        hasContent: true,
        entryCount: 2,
        wordCount: 8
      }
    }
  );

  assert.equal(harness.transcriptButton.textContent, "Tiếp tục ghi");
  harness.transcriptButton.dispatch("click");

  assert.deepEqual(harness.sentMessages.at(-1), {
    tabId: 7,
    message: { type: "transcript:start", reset: false }
  });
  assert.equal(harness.transcriptButton.textContent, "Dừng & tải TXT");
});

test("đổi video sẽ tải bản cũ trước khi khởi tạo phiên ghi mới", () => {
  const harness = createHarness(
    {},
    [],
    {
      initialState: {
        recording: false,
        hasContent: true,
        entryCount: 5,
        wordCount: 30,
        stoppedBecauseVideoChanged: true
      }
    }
  );

  assert.equal(
    harness.transcriptButton.textContent,
    "Tải cũ & ghi video mới"
  );
  harness.transcriptButton.dispatch("click");

  assert.deepEqual(
    harness.sentMessages.slice(-2).map((item) => item.message),
    [
      { type: "transcript:export" },
      { type: "transcript:start", reset: true }
    ]
  );
  assert.equal(harness.downloads.length, 1);
  assert.equal(harness.transcriptButton.textContent, "Dừng & tải TXT");
});

test("dừng ghi tự tải tệp TXT có BOM UTF-8 và thu hồi Blob URL", () => {
  const harness = createHarness(
    {},
    [],
    {
      initialState: {
        recording: true,
        hasContent: true,
        entryCount: 1,
        wordCount: 2
      }
    }
  );

  harness.transcriptButton.dispatch("click");

  assert.deepEqual(
    harness.sentMessages.slice(-2).map((item) => item.message.type),
    ["transcript:stop", "transcript:export"]
  );
  assert.equal(harness.downloads.length, 1);
  assert.equal(harness.downloads[0].filename, "youtube-phu-de_test.txt");
  assert.equal(harness.blobs.length, 1);
  assert.equal(harness.blobs[0].parts[0], "\uFEFF");
  assert.equal(harness.blobs[0].parts[1], "[00:00:01] Xin chào");
  assert.equal(harness.blobs[0].type, "text/plain;charset=utf-8");
  assert.deepEqual(harness.revokedObjectUrls, ["blob:test-0"]);
  assert.equal(harness.transcriptButton.textContent, "Tiếp tục ghi");
  assert.equal(harness.transcriptDownload.disabled, false);
});

test("dừng trước caption đầu tiên không tải tệp và không khóa popup", () => {
  const harness = createHarness(
    {},
    [],
    {
      initialState: {
        recording: true,
        hasContent: false,
        entryCount: 0,
        wordCount: 0
      }
    }
  );

  harness.transcriptButton.dispatch("click");

  assert.equal(harness.sentMessages.at(-1).message.type, "transcript:stop");
  assert.equal(
    harness.sentMessages.some(
      (item) => item.message.type === "transcript:export"
    ),
    false
  );
  assert.equal(harness.downloads.length, 0);
  assert.equal(harness.transcriptButton.disabled, false);
  assert.equal(harness.transcriptButton.textContent, "Bắt đầu ghi");
  assert.equal(harness.transcriptStatus.textContent, "Chưa ghi phụ đề.");
});

test("popup cập nhật số đoạn và số từ khi phiên ghi đang chạy", () => {
  const harness = createHarness(
    {},
    [],
    {
      initialState: {
        recording: true,
        hasContent: false,
        entryCount: 0,
        wordCount: 0
      }
    }
  );

  harness.setTranscriptState({
    hasContent: true,
    entryCount: 4,
    wordCount: 25
  });
  harness.runTranscriptPoll();

  assert.match(harness.transcriptStatus.textContent, /4 đoạn • 25 từ/);
  assert.equal(harness.transcriptDownload.disabled, false);
  assert.equal(harness.sentMessages.at(-1).message.type, "transcript:getState");
});

test("lỗi kết nối tab được hiển thị và không tạo tệp rỗng", () => {
  const harness = createHarness(
    {},
    [],
    {
      initialState: {
        recording: false,
        hasContent: true,
        entryCount: 1,
        wordCount: 2
      }
    }
  );
  harness.setRuntimeError("Receiving end does not exist");

  harness.transcriptDownload.dispatch("click");

  assert.equal(harness.downloads.length, 0);
  assert.equal(harness.transcriptStatus.dataset.state, "error");
  assert.match(
    harness.transcriptStatus.textContent,
    /Hãy mở hoặc tải lại một video YouTube/
  );
  assert.equal(harness.transcriptButton.disabled, true);
});
