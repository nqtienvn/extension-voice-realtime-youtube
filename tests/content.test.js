const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONTENT_SCRIPT = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function createHarness(savedSettings = {}, availableVoices = []) {
  let captionSegments = [];
  let storageListener = null;
  let runtimeListener = null;
  let cancelCount = 0;
  let currentVideoTime = 0;
  let currentVoices = [...availableVoices];
  const observers = [];
  const spoken = [];
  const spokenAt = [];
  const storageWrites = [];
  const voiceListeners = [];
  const persistedSettings = { ...savedSettings };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe() {}

    disconnect() {}
  }

  class FakeSpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
      this.onend = null;
      this.onerror = null;
    }
  }

  const speechSynthesis = {
    cancel() {
      cancelCount += 1;
    },
    getVoices() {
      return currentVoices;
    },
    speak(utterance) {
      spoken.push(utterance);
      spokenAt.push(Date.now());
    },
    addEventListener(event, listener) {
      if (event === "voiceschanged") voiceListeners.push(listener);
    }
  };

  const document = {
    body: {},
    documentElement: { lang: "vi" },
    title: "Video thử nghiệm - YouTube",
    querySelector(selector) {
      return selector === "video" ? { currentTime: currentVideoTime } : null;
    },
    querySelectorAll() {
      return captionSegments;
    }
  };
  const location = {
    href: "https://www.youtube.com/watch?v=video-thu-nghiem"
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
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        }
      }
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        }
      }
    }
  };

  function updateCaptionSegments(segments, replaceNodes) {
    const texts = segments.filter(Boolean);
    const previousSegments = captionSegments;
    captionSegments = texts.map((text, index) => {
      const segment =
        !replaceNodes && previousSegments[index]
          ? previousSegments[index]
          : {
              textContent: "",
              parentElement: {},
              closest(selector) {
                return selector === ".caption-visual-line" ? this.parentElement : null;
              }
            };
      segment.textContent = text;
      return segment;
    });
  }

  vm.runInNewContext(CONTENT_SCRIPT, {
    chrome,
    clearTimeout,
    document,
    location,
    MutationObserver: FakeMutationObserver,
    navigator: { language: "vi-VN" },
    setTimeout,
    speechSynthesis,
    SpeechSynthesisUtterance: FakeSpeechSynthesisUtterance
  });

  return {
    get cancelCount() {
      return cancelCount;
    },
    spoken,
    spokenAt,
    storageWrites,
    sendRuntimeMessage(message) {
      let response;
      runtimeListener(message, {}, (value) => {
        response = value;
      });
      return response;
    },
    setVideo({ href, title, time } = {}) {
      if (typeof href === "string") location.href = href;
      if (typeof title === "string") document.title = title;
      if (Number.isFinite(time)) currentVideoTime = time;
    },
    changeSettings(changes) {
      const storageChanges = Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [key, { newValue: value }])
      );
      Object.assign(persistedSettings, changes);
      storageListener(storageChanges, "sync");
    },
    endSpeech(index) {
      spoken[index].onend();
    },
    failSpeech(index) {
      spoken[index].onerror();
    },
    setVoices(voices) {
      currentVoices = [...voices];
    },
    emitVoicesChanged() {
      for (const listener of voiceListeners) listener();
    },
    mutate() {
      for (const observer of observers) observer.callback([], observer);
    },
    replaceCaption(...segments) {
      updateCaptionSegments(segments, true);
    },
    setCaption(...segments) {
      updateCaptionSegments(segments, false);
    }
  };
}

function waitForCaptionSettle() {
  // Includes the 40 ms DOM settle, 260 ms speech coalescing, and timer margin.
  return new Promise((resolve) => setTimeout(resolve, 430));
}

function waitForCaptionProcessing() {
  return new Promise((resolve) => setTimeout(resolve, 110));
}

test("caption mới chờ câu đang đọc xong, kể cả cấu hình cũ từng cho phép ngắt", async () => {
  const harness = createHarness({ interruptPrevious: true });

  harness.setCaption("Câu đầu tiên");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "Câu đầu tiên");

  harness.replaceCaption("Câu thứ hai");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.cancelCount, 0);
  assert.equal(harness.spoken.length, 1);

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "Câu thứ hai");
});

test("cue rỗng tức thời không làm mất hoặc tách hai caption ngắn", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  harness.setCaption();
  harness.mutate();
  harness.setCaption("B");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "A B");
});

test("hai caption cùng câu xuất hiện trong 40 ms được nối đúng thứ tự", async () => {
  const harness = createHarness();

  harness.setCaption("caption A");
  harness.mutate();
  harness.replaceCaption("caption B");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "caption A caption B");
});

test("node caption mới trong cùng câu được nối thành một utterance", async () => {
  const harness = createHarness();

  harness.setCaption("Hôm nay chúng ta");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.replaceCaption("sẽ học về trí tuệ nhân tạo");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(
    harness.spoken[0].text,
    "Hôm nay chúng ta sẽ học về trí tuệ nhân tạo"
  );
});

test("cue rỗng rất ngắn chỉ là re-render và vẫn nối cùng câu", async () => {
  const harness = createHarness();

  harness.setCaption("Đây là một");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setCaption();
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 80));

  harness.replaceCaption("ví dụ đọc liền mạch");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "Đây là một ví dụ đọc liền mạch");
});

test("cue rỗng ngắn không lặp lại caption tích lũy trong giọng đọc và bản ghi", async () => {
  const harness = createHarness();
  harness.sendRuntimeMessage({ type: "transcript:start" });

  harness.setCaption("Xin chào");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setCaption();
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 80));

  harness.replaceCaption("Xin chào bạn");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "Xin chào bạn");

  const exported = harness.sendRuntimeMessage({ type: "transcript:export" });
  assert.equal(exported.state.entryCount, 1);
  assert.equal(exported.state.wordCount, 3);
  assert.match(exported.content, /\] Xin chào bạn/);
  assert.doesNotMatch(exported.content, /Xin chào Xin chào bạn/);
});

test("cue rỗng ngắn vẫn giữ hai caption khác nhau có nhiều từ chung", async () => {
  const harness = createHarness();
  harness.sendRuntimeMessage({ type: "transcript:start" });

  harness.setCaption("tôi đi học");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setCaption();
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 80));

  harness.replaceCaption("tôi đã đi học");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "tôi đi học tôi đã đi học");

  const exported = harness.sendRuntimeMessage({ type: "transcript:export" });
  assert.equal(exported.state.entryCount, 2);
  assert.equal(exported.state.wordCount, 7);
  assert.match(exported.content, /tôi đi học/);
  assert.match(exported.content, /tôi đã đi học/);
});

test("cue giống hệt sau khoảng rỗng ngắn vẫn được giữ để không mất câu lặp", async () => {
  const harness = createHarness();
  harness.sendRuntimeMessage({ type: "transcript:start" });

  harness.setCaption("echo");
  harness.mutate();
  await waitForCaptionProcessing();
  harness.setCaption();
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 80));
  harness.replaceCaption("echo");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "echo echo");
  const exported = harness.sendRuntimeMessage({ type: "transcript:export" });
  assert.equal(exported.state.entryCount, 2);
  assert.equal(exported.state.wordCount, 2);
});

test("cue rỗng ngắn không làm lùi watermark khi caption co rồi phục hồi", async () => {
  const harness = createHarness();
  harness.sendRuntimeMessage({ type: "transcript:start" });

  harness.setCaption("hello");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setCaption();
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 80));

  harness.replaceCaption("hel");
  harness.mutate();
  await waitForCaptionProcessing();
  harness.setCaption("hello");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "hello");

  const exported = harness.sendRuntimeMessage({ type: "transcript:export" });
  assert.equal(exported.state.entryCount, 1);
  assert.equal(exported.state.wordCount, 1);
  assert.doesNotMatch(exported.content, /hellolo/);
});

test("cue rỗng ngắn sát hard deadline vẫn giữ nguyên một cụm đọc", async () => {
  const harness = createHarness();

  harness.setCaption("một hai");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 280));

  harness.setCaption();
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 290));

  harness.replaceCaption("ba bốn");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "một hai ba");
  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "bốn");
});

test("nhiều cue rỗng ngắn không được kéo dài hard deadline vô hạn", async () => {
  const harness = createHarness();
  let caption = "một hai";

  harness.setCaption(caption);
  harness.mutate();

  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    harness.setCaption();
    harness.mutate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    caption += ` ${index}`;
    harness.replaceCaption(caption);
    harness.mutate();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(harness.spoken.length, 1);
  assert.match(harness.spoken[0].text, /^một hai(?: 0)?/);
});

test("cue rỗng đủ lâu tạo ranh giới phát âm", async () => {
  const harness = createHarness();

  harness.setCaption("Đang đọc trước");
  harness.mutate();
  await waitForCaptionSettle();

  harness.replaceCaption("Vế thứ nhất");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setCaption();
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 400));

  harness.replaceCaption("Vế thứ hai");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "Đang đọc trước");
  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "Vế thứ nhất");
  harness.endSpeech(1);
  assert.equal(harness.spoken.length, 3);
  assert.equal(harness.spoken[2].text, "Vế thứ hai");
});

test("audio kết thúc trong cue rỗng ngắn vẫn chờ để nối phần tiếp theo", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("B");
  harness.mutate();
  await waitForCaptionSettle();

  harness.replaceCaption("C one");
  harness.mutate();
  await waitForCaptionProcessing();
  harness.setCaption();
  harness.mutate();
  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 80));
  harness.replaceCaption("C one more");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "B C one more");
});

test("dấu kết câu tạo boundary dù node đổi không có khoảng trống", async () => {
  const harness = createHarness();

  harness.setCaption("Đang đọc trước");
  harness.mutate();
  await waitForCaptionSettle();

  harness.replaceCaption("Đây là câu thứ nhất.");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.replaceCaption("Đây là câu thứ hai");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "Đang đọc trước");
  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "Đây là câu thứ nhất.");
  harness.endSpeech(1);
  assert.equal(harness.spoken.length, 3);
  assert.equal(harness.spoken[2].text, "Đây là câu thứ hai");
});

test("nối cue không phát bản nháp giữa từ và vẫn giữ latency", async () => {
  const harness = createHarness();

  harness.setCaption("Chúng ta đang ngh");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setCaption("Chúng ta đang nghiêng");
  harness.mutate();
  await waitForCaptionProcessing();

  const continuedAt = Date.now();
  harness.replaceCaption("sang bên trái");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 380));

  assert.equal(harness.spoken.length, 1);
  assert.equal(
    harness.spoken[0].text,
    "Chúng ta đang nghiêng sang bên trái"
  );
  assert.equal(
    harness.spoken.some((utterance) => /(?:^|\s)ngh(?:\s|$)/u.test(utterance.text)),
    false
  );
  assert.ok(
    harness.spokenAt[0] - continuedAt < 380,
    `TTS bắt đầu sau ${harness.spokenAt[0] - continuedAt} ms kể từ cue nối tiếp`
  );
});

test("caption cuộn với đoạn giao rõ ràng chỉ thêm phần mới", async () => {
  const harness = createHarness();

  harness.setCaption("một hai ba");
  harness.mutate();
  await waitForCaptionSettle();

  harness.setCaption("hai ba bốn");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "bốn");
});

test("dòng hai chuyển lên dòng một không bị đọc lại khi node DOM được tạo mới", async () => {
  const harness = createHarness();

  harness.setCaption("Dòng một");
  harness.mutate();
  await waitForCaptionSettle();

  harness.setCaption("Dòng một", "Dòng hai đang đọc");
  harness.mutate();
  await waitForCaptionSettle();
  harness.endSpeech(0);

  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "Dòng hai đang đọc");

  // YouTube removes line 1 and recreates the old line 2 as a brand-new line 1.
  harness.replaceCaption("Dòng hai đang đọc");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 2);

  // New words now appear below/after that moved line while it is still spoken.
  harness.replaceCaption("Dòng hai đang đọc", "Nội dung mới");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("Dòng hai đang đọc", "Nội dung mới tiếp tục");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 2);
  harness.endSpeech(1);
  assert.equal(harness.spoken[2].text, "Nội dung mới tiếp tục");
  assert.equal(
    harness.spoken.filter((utterance) => utterance.text === "Dòng hai đang đọc").length,
    1
  );
});

test("phần đã xếp hàng của dòng hai vẫn được nhớ sau khi dòng đó cuộn lên", async () => {
  const harness = createHarness();

  harness.setCaption("một");
  harness.mutate();
  await waitForCaptionSettle();
  harness.setCaption("một", "hai");
  harness.mutate();
  await waitForCaptionSettle();
  harness.endSpeech(0);

  assert.equal(harness.spoken[1].text, "hai");

  harness.setCaption("một", "hai ba");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("hai ba");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("hai ba bốn");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 2);
  harness.endSpeech(1);
  assert.equal(harness.spoken[2].text, "ba bốn");
  assert.deepEqual(
    harness.spoken.map((utterance) => utterance.text),
    ["một", "hai", "ba bốn"]
  );
});

test("dòng cuộn bằng node mới vẫn nối đúng phần còn lại của một từ", async () => {
  const harness = createHarness();

  harness.setCaption("một");
  harness.mutate();
  await waitForCaptionSettle();
  harness.setCaption("một", "hel");
  harness.mutate();
  await waitForCaptionProcessing();
  assert.equal(harness.spoken.length, 1);

  harness.replaceCaption("hello");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  harness.endSpeech(0);
  assert.equal(harness.spoken[1].text, "hello");
  assert.deepEqual(
    harness.spoken.map((utterance) => utterance.text),
    ["một", "hello"]
  );
});

test("dòng dưới tạm biến mất vẫn giữ mốc chữ đã xếp hàng khi hiện lại", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  await waitForCaptionSettle();
  harness.setCaption("A", "B");
  harness.mutate();
  await waitForCaptionSettle();
  harness.endSpeech(0);

  harness.replaceCaption("B", "C");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("B");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("B", "C thêm");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 2);
  harness.endSpeech(1);
  assert.equal(harness.spoken[2].text, "C thêm");
  assert.deepEqual(
    harness.spoken.map((utterance) => utterance.text),
    ["A", "B", "C thêm"]
  );
});

test("các delta gần nhau được ghép thành một cụm đọc liền mạch", async () => {
  const harness = createHarness();

  harness.setCaption("chúng");
  harness.mutate();
  await waitForCaptionProcessing();
  assert.equal(harness.spoken.length, 0);

  harness.setCaption("chúng ta");
  harness.mutate();
  await waitForCaptionProcessing();
  harness.setCaption("chúng ta nghe rõ");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "chúng ta nghe rõ");
});

test("hậu tố của cùng một từ được ghép liền trước khi phát âm", async () => {
  const harness = createHarness();

  harness.setCaption("hel");
  harness.mutate();
  await waitForCaptionProcessing();
  assert.equal(harness.spoken.length, 0);

  harness.setCaption("hello");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "hello");
});

test("audio vừa rảnh không tách gốc từ khỏi hậu tố khi node kế tiếp đã tới", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  await waitForCaptionSettle();

  harness.replaceCaption("hel");
  harness.mutate();
  await waitForCaptionSettle();

  harness.setCaption("hello");
  harness.mutate();
  await waitForCaptionProcessing();
  harness.replaceCaption("world again");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "hello world");
  assert.notEqual(harness.spoken[1].text, "hel");

  await new Promise((resolve) => setTimeout(resolve, 350));
  harness.endSpeech(1);
  assert.equal(harness.spoken.length, 3);
  assert.equal(harness.spoken[2].text, "again");
});

test("dấu câu nối vào từ trước không trở thành utterance rời", async () => {
  const harness = createHarness();

  harness.setCaption("hello");
  harness.mutate();
  await waitForCaptionProcessing();
  harness.setCaption("hello!");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "hello!");
});

test("luồng caption liên tục vẫn được phát trong giới hạn chờ tối đa", async () => {
  const harness = createHarness();
  let caption = "một";

  harness.setCaption(caption);
  harness.mutate();

  for (let index = 1; index <= 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    caption += ` ${index}`;
    harness.setCaption(caption);
    harness.mutate();
  }

  assert.equal(harness.spoken.length, 1);
  assert.match(harness.spoken[0].text, /^một 1 2/);
});

test("tắt extension khi cụm chữ còn trong bộ đệm thì không phát muộn", async () => {
  const harness = createHarness();

  harness.setCaption("chưa được phát");
  harness.mutate();
  await waitForCaptionProcessing();
  assert.equal(harness.spoken.length, 0);

  harness.changeSettings({ enabled: false });
  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.equal(harness.cancelCount, 1);
  assert.equal(harness.spoken.length, 0);
});

test("node caption mới giữ nguyên câu sau dù nó lặp hai từ ở ranh giới", async () => {
  const harness = createHarness();

  harness.setCaption("I moved to New York");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("New York is beautiful");
  harness.mutate();
  await waitForCaptionSettle();

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "New York is beautiful");
});

test("câu mới giống hệt nhưng dùng node DOM mới vẫn được đọc lại", async () => {
  const harness = createHarness();

  harness.setCaption("echo");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("echo");
  harness.mutate();
  await waitForCaptionSettle();

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "echo");
});

test("caption co lại không làm lùi mốc phần chữ đã xếp hàng", async () => {
  const harness = createHarness();

  harness.setCaption("hello world");
  harness.mutate();
  harness.setCaption("hello");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "hello world");

  harness.setCaption("hello world again");
  harness.mutate();
  await waitForCaptionSettle();
  harness.setCaption("hello world");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "again");
});

test("caption tăng liên tục vẫn được đẩy vào FIFO trước khi mutation dừng", async () => {
  const harness = createHarness();
  let caption = "zero";

  harness.setCaption(caption);
  harness.mutate();

  for (let index = 1; index <= 7; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    caption += ` ${index}`;
    harness.setCaption(caption);
    harness.mutate();
  }

  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 1);
  assert.match(harness.spoken[0].text, /^zero 1 2 3 4 5/);
});

test("các bản nháp từng ký tự được gom thành chữ hoàn chỉnh và mutation trùng bị bỏ qua", async () => {
  const harness = createHarness();

  harness.setCaption("hel");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 15));
  harness.setCaption("hell");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 15));
  harness.setCaption("hello");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 15));
  harness.setCaption("hello world");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "hello world");

  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 1);

  harness.setCaption("hello world again");
  harness.mutate();
  await waitForCaptionSettle();
  harness.endSpeech(0);

  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "again");
});

test("ASR sửa từ cuối trong cửa sổ đệm thì thay bản nháp thay vì đọc cả hai", async () => {
  const harness = createHarness();

  harness.setCaption("tôi đi học");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 150));
  harness.setCaption("tôi đi họp");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "tôi đi họp");
});

test("ASR thêm dấu tiếng Việt vào một từ thì chỉ đọc bản đã sửa", async () => {
  const harness = createHarness();

  harness.setCaption("ban");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 150));
  harness.setCaption("bạn");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "bạn");
});

test("mutation sát quiet deadline không tách một từ thành hai utterance", async () => {
  const harness = createHarness();

  harness.setCaption("ngh");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 280));
  harness.setCaption("nghiêng");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "nghiêng");
});

test("mutation đang chờ commit chặn hard deadline phát prefix cũ", async () => {
  const harness = createHarness();

  harness.setCaption("toi n");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 200));
  harness.setCaption("toi ng");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 200));
  harness.setCaption("toi ngh");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 170));
  harness.setCaption("tôi ngh");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "tôi");
  harness.endSpeech(0);
  assert.equal(harness.spoken[1].text, "ngh");
  assert.equal(
    harness.spoken.some((utterance) => utterance.text === "toi"),
    false
  );
});

test("hai cụm khác nghĩa chỉ giống phần đầu không bị coi là sửa chính tả", async () => {
  const harness = createHarness();

  harness.setCaption("tôi chọn A");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 150));
  harness.setCaption("tôi chọn B");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "tôi chọn A tôi chọn B");
});

test("lỗi giọng đọc vẫn giải phóng hàng đợi cho mục kế tiếp", async () => {
  const harness = createHarness();

  harness.setCaption("mục một");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("mục hai");
  harness.mutate();
  await waitForCaptionSettle();

  harness.failSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "mục hai");
});

test("tắt extension xóa hàng đợi và callback cũ không thể phát tiếp", async () => {
  const harness = createHarness();

  harness.setCaption("đang đọc");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("đang chờ");
  harness.mutate();
  await waitForCaptionSettle();

  harness.changeSettings({ enabled: false });
  assert.equal(harness.cancelCount, 1);

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 1);
});

test("chuẩn hóa Unicode NFC trước khi so sánh và đọc tiếng Việt", async () => {
  const harness = createHarness();
  const decomposed = "Tiếng Việt".normalize("NFD");

  harness.setCaption(decomposed);
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken[0].text, "Tiếng Việt");

  // Cùng nội dung nhưng đổi từ NFD sang NFC không phải là một caption mới.
  harness.setCaption("Tiếng Việt");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 1);
});

test("loại ký tự định dạng vô hình nhưng giữ nguyên nội dung tiếng Việt", async () => {
  const harness = createHarness();

  harness.setCaption("Ti\u200Bếng Vi\u00ADệt\u2060 Nam");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken[0].text, "Tiếng Việt Nam");
});

test("chuẩn hóa khoảng trắng trước dấu câu ngay trước khi phát âm", async () => {
  const harness = createHarness();

  harness.setCaption("Xin chào ,  Việt Nam !");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken[0].text, "Xin chào, Việt Nam!");
});

test("thay đổi khoảng trắng trước dấu câu không làm đọc lặp", async () => {
  const harness = createHarness();

  harness.setCaption("Xin chào ,");
  harness.mutate();
  await waitForCaptionSettle();

  harness.setCaption("Xin chào,");
  harness.mutate();
  await waitForCaptionSettle();
  harness.endSpeech(0);

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "Xin chào,");
});

test("bỏ cue phi lời nói nhưng không chặn caption kế tiếp", async () => {
  const harness = createHarness();

  harness.setCaption("[Music]");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 0);

  harness.replaceCaption("Xin chào");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "Xin chào");
});

test("bỏ cue và nốt nhạc đã biết nhưng giữ nhãn người nói", async () => {
  const cueHarness = createHarness();

  cueHarness.setCaption("[ÂM NHẠC] ♪ Tôi yêu Việt Nam ♪ [Applause]");
  cueHarness.mutate();
  await waitForCaptionSettle();
  assert.equal(cueHarness.spoken[0].text, "Tôi yêu Việt Nam");

  const labelHarness = createHarness();
  labelHarness.setCaption("[Người dẫn] Xin chào [A]");
  labelHarness.mutate();
  await waitForCaptionSettle();
  assert.equal(labelHarness.spoken[0].text, "[Người dẫn] Xin chào [A]");

  const lessonHarness = createHarness();
  const lesson = "Music (âm nhạc) là một danh từ";
  lessonHarness.setCaption(lesson);
  lessonHarness.mutate();
  await waitForCaptionSettle();
  assert.equal(lessonHarness.spoken[0].text, lesson);
});

test("đọc rõ phần trăm, đồng và độ C mà không đổi ký hiệu mơ hồ", async () => {
  const symbolHarness = createHarness();

  symbolHarness.setCaption("Pin 12,5%, giá 100.000₫, nhiệt độ 30°C.");
  symbolHarness.mutate();
  await waitForCaptionSettle();
  assert.equal(
    symbolHarness.spoken[0].text,
    "Pin 12,5 phần trăm, giá 100.000 đồng, nhiệt độ 30 độ C."
  );

  const ambiguousHarness = createHarness();
  const ambiguous =
    "AI/API 2.10.3, 03/04/2026, +84, x % 2, 10 % 3, được 10đ, lớp 10Đ, H&M";
  ambiguousHarness.setCaption(ambiguous);
  ambiguousHarness.mutate();
  await waitForCaptionSettle();
  assert.equal(ambiguousHarness.spoken[0].text, ambiguous);
});

test("chọn đúng giọng Việt và chuẩn hóa lang vi_VN thành BCP-47", async () => {
  const englishVoice = {
    name: "English",
    lang: "en_US",
    voiceURI: "voice-en",
    default: true,
    localService: true
  };
  const vietnameseVoice = {
    name: "Vietnamese",
    lang: "vi_VN",
    voiceURI: "voice-vi",
    default: false,
    localService: false
  };
  const harness = createHarness(
    {
      rate: 0.9,
      voiceURI: vietnameseVoice.voiceURI,
      ttsSettingsVersion: 1
    },
    [englishVoice, vietnameseVoice]
  );

  harness.setCaption("Xin chào");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken[0].voice.voiceURI, "voice-vi");
  assert.equal(harness.spoken[0].lang, "vi-VN");
  assert.equal(harness.spoken[0].rate, 0.9);
});

test("tôn trọng voice khác ngôn ngữ khi người dùng chọn thủ công", async () => {
  const englishVoice = {
    name: "English",
    lang: "en_US",
    voiceURI: "voice-en",
    default: true,
    localService: true
  };
  const vietnameseVoice = {
    name: "Vietnamese",
    lang: "vi-VN",
    voiceURI: "voice-vi",
    default: false,
    localService: false
  };
  const harness = createHarness(
    {
      voiceURI: englishVoice.voiceURI,
      allowAnyVoice: true,
      ttsSettingsVersion: 1
    },
    [englishVoice, vietnameseVoice]
  );

  harness.setCaption("Xin chào");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].voice.voiceURI, englishVoice.voiceURI);
  assert.equal(harness.spoken[0].lang, "en-US");
});

test("không kích hoạt voice ngoại ngữ cũ nếu chưa được chọn trong giao diện mới", async () => {
  const englishVoice = {
    name: "English legacy",
    lang: "en-US",
    voiceURI: "voice-en-legacy",
    default: true,
    localService: true
  };
  const vietnameseVoice = {
    name: "Vietnamese",
    lang: "vi-VN",
    voiceURI: "voice-vi",
    default: false,
    localService: true
  };
  const harness = createHarness(
    {
      voiceURI: englishVoice.voiceURI,
      ttsSettingsVersion: 1
    },
    [englishVoice, vietnameseVoice]
  );

  harness.setCaption("Xin chào");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].voice.voiceURI, vietnameseVoice.voiceURI);
  assert.equal(harness.spoken[0].lang, "vi-VN");
});

test("voice ngoại cũ tải muộn sẽ fallback giọng Việt ngay không chờ hết hạn", async () => {
  const legacyVoice = {
    name: "English legacy",
    lang: "en-US",
    voiceURI: "voice-en-legacy",
    default: true,
    localService: true
  };
  const vietnameseVoice = {
    name: "Vietnamese",
    lang: "vi-VN",
    voiceURI: "voice-vi",
    default: false,
    localService: true
  };
  const harness = createHarness({
    voiceURI: legacyVoice.voiceURI,
    ttsSettingsVersion: 1
  });

  harness.setCaption("Fallback tức thì");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 0);

  harness.setVoices([legacyVoice, vietnameseVoice]);
  harness.emitVoicesChanged();
  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].voice.voiceURI, vietnameseVoice.voiceURI);
  assert.equal(harness.spoken[0].lang, "vi-VN");
});

test("chế độ tự động vẫn ưu tiên giọng Việt trước voice mặc định khác", async () => {
  const englishVoice = {
    name: "English",
    lang: "en-US",
    voiceURI: "voice-en",
    default: true,
    localService: true
  };
  const vietnameseVoice = {
    name: "Vietnamese",
    lang: "vi-VN",
    voiceURI: "voice-vi",
    default: false,
    localService: false
  };
  const harness = createHarness(
    { voiceURI: "", ttsSettingsVersion: 1 },
    [englishVoice, vietnameseVoice]
  );

  harness.setCaption("Xin chào");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].voice.voiceURI, vietnameseVoice.voiceURI);
  assert.equal(harness.spoken[0].lang, "vi-VN");
});

test("chờ danh sách voice tải xong trước câu đầu khi đã chọn voice cụ thể", async () => {
  const englishVoice = {
    name: "English",
    lang: "en-US",
    voiceURI: "voice-en",
    default: true,
    localService: true
  };
  const vietnameseVoice = {
    name: "Vietnamese",
    lang: "vi-VN",
    voiceURI: "voice-vi",
    default: true,
    localService: true
  };
  const harness = createHarness({
    voiceURI: vietnameseVoice.voiceURI,
    ttsSettingsVersion: 1
  }, [englishVoice]);

  harness.setCaption("Câu đầu tiên");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 0);

  harness.emitVoicesChanged();
  assert.equal(harness.spoken.length, 0);

  harness.setVoices([englishVoice, vietnameseVoice]);
  harness.emitVoicesChanged();
  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].voice.voiceURI, "voice-vi");
});

test("đổi voice trong lúc đang chờ sẽ phát ngay bằng voice mới đã sẵn sàng", async () => {
  const readyVoice = {
    name: "Vietnamese ready",
    lang: "vi-VN",
    voiceURI: "voice-ready",
    default: true,
    localService: true
  };
  const harness = createHarness({
    voiceURI: "voice-missing",
    ttsSettingsVersion: 1
  });

  harness.setCaption("Xin chào");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 0);

  harness.setVoices([readyVoice]);
  harness.changeSettings({ voiceURI: readyVoice.voiceURI });
  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].voice.voiceURI, readyVoice.voiceURI);
});

test("chọn voice mới sau cửa sổ khởi động vẫn chờ voice đó tải", async () => {
  const vietnameseVoice = {
    name: "Vietnamese fallback",
    lang: "vi-VN",
    voiceURI: "voice-vi",
    default: true,
    localService: true
  };
  const lateVoice = {
    name: "English late",
    lang: "en-US",
    voiceURI: "voice-en-late",
    default: false,
    localService: false
  };
  const harness = createHarness({}, [vietnameseVoice]);

  await new Promise((resolve) => setTimeout(resolve, 650));
  harness.changeSettings({
    voiceURI: lateVoice.voiceURI,
    allowAnyVoice: true
  });
  harness.setCaption("Voice vừa chọn");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 0);

  harness.setVoices([vietnameseVoice, lateVoice]);
  harness.emitVoicesChanged();
  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].voice.voiceURI, lateVoice.voiceURI);
  assert.equal(harness.spoken[0].lang, "en-US");
});

test("migration chỉ đổi tốc độ mặc định cũ và giữ cấu hình tùy chỉnh", () => {
  const custom = createHarness({
    rate: 2,
    voiceURI: "voice-vi",
    ttsSettingsVersion: 0
  });
  assert.deepEqual(custom.storageWrites[0], {
    rate: 2,
    ttsSettingsVersion: 1
  });

  const legacy = createHarness({
    rate: 1.35,
    voiceURI: "voice-vi",
    ttsSettingsVersion: 0
  });
  assert.deepEqual(legacy.storageWrites[0], {
    rate: 1,
    ttsSettingsVersion: 1
  });
});

test("deadline chỉ phát các từ hoàn chỉnh và giữ hậu tố đang được dựng", async () => {
  const harness = createHarness();
  const drafts = [
    "xin n",
    "xin ng",
    "xin ngh",
    "xin nghi",
    "xin nghiê",
    "xin nghiêng"
  ];

  harness.setCaption(drafts[0]);
  harness.mutate();
  for (const draft of drafts.slice(1)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    harness.setCaption(draft);
    harness.mutate();
  }
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "xin");
  harness.endSpeech(0);
  assert.equal(harness.spoken[1].text, "nghiêng");
});

test("hard deadline không khởi động lại quiet timer sắp hoàn tất", async () => {
  const harness = createHarness();

  harness.setCaption("n");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 150));
  harness.setCaption("ng");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 140));
  harness.setCaption("nghi");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 430));

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "nghi");
});

test("audio vừa rảnh không bỏ qua cửa sổ sửa bản nháp ASR", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("tôi n");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 1);

  harness.setCaption("tôi nay");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "tôi nay");
});

test("deadline giữ quan hệ nối từ khi bản nháp đang chờ sau câu khác", async () => {
  const harness = createHarness();

  harness.setCaption("trước");
  harness.mutate();
  await waitForCaptionSettle();

  harness.replaceCaption("n");
  harness.mutate();
  await waitForCaptionSettle();

  for (const draft of ["ng", "ngh", "nghi", "nghiê", "nghiên", "nghiêng"]) {
    harness.setCaption(draft);
    harness.mutate();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await waitForCaptionSettle();

  harness.endSpeech(0);
  assert.equal(harness.spoken[1].text, "nghiêng");
});

test("đuôi từ đang đổi không chặn tiền tố ổn định đã đến hạn", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  await waitForCaptionSettle();

  harness.replaceCaption("xin a");
  harness.mutate();
  for (const draft of [
    "xin ab",
    "xin abc",
    "xin abcd",
    "xin abcde",
    "xin abcdef"
  ]) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    harness.setCaption(draft);
    harness.mutate();
  }
  await waitForCaptionProcessing();

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "xin");
});

test("caption một từ đang gom được nối vào mục FIFO sau cửa sổ ổn định", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("B");
  harness.mutate();
  await waitForCaptionSettle();

  harness.replaceCaption("n");
  harness.mutate();
  await waitForCaptionProcessing();
  harness.endSpeech(0);

  assert.equal(harness.spoken.length, 1);
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "B n");
});

test("hard deadline phát mục FIFO cũ dù hậu tố cùng caption còn đang đổi", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("xin");
  harness.mutate();
  await waitForCaptionSettle();

  harness.setCaption("xin n");
  harness.mutate();
  await waitForCaptionProcessing();
  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 1);

  for (const draft of [
    "xin ng",
    "xin ngh",
    "xin nghi",
    "xin nghiê",
    "xin nghiên"
  ]) {
    harness.setCaption(draft);
    harness.mutate();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "xin");
});

test("hard deadline không phát tiền tố đang chờ nối thành cùng một từ", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("n");
  harness.mutate();
  await waitForCaptionSettle();

  for (const draft of ["ng", "ngh", "nghi", "nghiê", "nghiên"]) {
    harness.setCaption(draft);
    harness.mutate();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 1);

  harness.setCaption("nghiêng");
  harness.mutate();
  await waitForCaptionSettle();
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "nghiêng");
});

test("caption ổn định bắt đầu TTS trong khoảng dưới 380 ms", async () => {
  const harness = createHarness();
  const startedAt = Date.now();

  harness.setCaption("Phản hồi nhanh");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 380));

  assert.equal(harness.spoken.length, 1);
  assert.ok(
    harness.spokenAt[0] - startedAt < 380,
    `TTS bắt đầu sau ${harness.spokenAt[0] - startedAt} ms`
  );
});

test("hết cửa sổ tải voice từ document_start thì không cộng thêm 600 ms", async () => {
  const harness = createHarness({
    voiceURI: "voice-không-còn-tồn-tại",
    ttsSettingsVersion: 1
  });
  await new Promise((resolve) => setTimeout(resolve, 650));
  const startedAt = Date.now();

  harness.setCaption("Không chờ voice cũ");
  harness.mutate();
  await new Promise((resolve) => setTimeout(resolve, 380));

  assert.equal(harness.spoken.length, 1);
  assert.ok(harness.spokenAt[0] - startedAt < 380);
  assert.equal(harness.spoken[0].lang, "vi-VN");
});

test("caption chờ được nối liền và vẫn tự tăng nhẹ tốc độ khi bám sau video", async () => {
  const harness = createHarness({ rate: 1, ttsSettingsVersion: 1 });

  harness.setCaption("A");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("B");
  harness.mutate();
  await waitForCaptionSettle();
  harness.replaceCaption("C");
  harness.mutate();
  await waitForCaptionSettle();

  harness.endSpeech(0);
  assert.equal(harness.spoken[1].text, "B C");
  assert.equal(harness.spoken[1].rate, 1.1);
});

test("ghi phụ đề độc lập với TTS và thay bản nháp bằng tiếng Việt đã sửa dấu", async () => {
  const harness = createHarness({
    enabled: false,
    ttsSettingsVersion: 1
  });

  const started = harness.sendRuntimeMessage({
    type: "transcript:start"
  });
  assert.equal(started.ok, true);
  assert.equal(started.state.recording, true);

  harness.setVideo({ time: 12 });
  harness.setCaption("toi di hoc");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setCaption("tôi đi học");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setVideo({ time: 15 });
  harness.setCaption("tôi đi học hôm nay");
  harness.mutate();
  await waitForCaptionProcessing();

  const exported = harness.sendRuntimeMessage({
    type: "transcript:export"
  });
  assert.equal(exported.ok, true);
  assert.match(exported.content, /\[00:00:12\] tôi đi học hôm nay/);
  assert.doesNotMatch(exported.content, /toi di hoc/);
  assert.equal(exported.state.entryCount, 1);
  assert.equal(exported.state.wordCount, 5);
  assert.equal(harness.spoken.length, 0);
});

test("dừng hoặc tải ngay vẫn chốt caption còn trong cửa sổ debounce", () => {
  const stoppedHarness = createHarness({ enabled: false });
  stoppedHarness.sendRuntimeMessage({ type: "transcript:start" });
  stoppedHarness.setVideo({ time: 7 });
  stoppedHarness.setCaption("Caption vừa xuất hiện");
  stoppedHarness.mutate();

  const stopped = stoppedHarness.sendRuntimeMessage({
    type: "transcript:stop"
  });
  assert.equal(stopped.state.entryCount, 1);
  const stoppedExport = stoppedHarness.sendRuntimeMessage({
    type: "transcript:export"
  });
  assert.match(stoppedExport.content, /\[00:00:07\] Caption vừa xuất hiện/);

  const liveHarness = createHarness({ enabled: false });
  liveHarness.sendRuntimeMessage({ type: "transcript:start" });
  liveHarness.setCaption("Caption tải tức thì");
  liveHarness.mutate();
  const liveExport = liveHarness.sendRuntimeMessage({
    type: "transcript:export"
  });
  assert.match(liveExport.content, /Caption tải tức thì/);
  assert.equal(liveExport.state.recording, true);
});

test("khoảng trống giữa hai cue tạo đoạn và timestamp mới", async () => {
  const harness = createHarness({ enabled: false });
  harness.sendRuntimeMessage({ type: "transcript:start" });

  harness.setVideo({ time: 1 });
  harness.setCaption("Cue đầu");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setCaption();
  harness.mutate();
  harness.setVideo({ time: 5 });
  harness.replaceCaption("Cue sau");
  harness.mutate();
  await waitForCaptionProcessing();

  const exported = harness.sendRuntimeMessage({
    type: "transcript:export"
  });
  assert.equal(exported.state.entryCount, 2);
  assert.match(exported.content, /\[00:00:01\] Cue đầu/);
  assert.match(exported.content, /\[00:00:05\] Cue sau/);
  assert.doesNotMatch(exported.content, /Cue đầu Cue sau/);
});

test("ASR chèn nhiều từ trong cùng cue sẽ sửa bản ghi thay vì nối hai bản", async () => {
  const harness = createHarness({ enabled: false });
  harness.sendRuntimeMessage({ type: "transcript:start" });

  harness.setCaption("tôi đi học");
  harness.mutate();
  await waitForCaptionProcessing();
  harness.setCaption("tôi đã đi học");
  harness.mutate();
  await waitForCaptionProcessing();

  const exported = harness.sendRuntimeMessage({
    type: "transcript:export"
  });
  assert.equal(exported.state.entryCount, 1);
  assert.equal(exported.state.wordCount, 4);
  assert.match(exported.content, /\] tôi đã đi học/);
  assert.doesNotMatch(exported.content, /tôi đi học tôi đã đi học/);
});

test("bản ghi giữ caption mới giống hệt nhưng không ghi thêm sau khi dừng", async () => {
  const harness = createHarness({ enabled: false });

  harness.sendRuntimeMessage({ type: "transcript:start" });
  harness.setVideo({ time: 1 });
  harness.setCaption("lặp lại");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setVideo({ time: 3 });
  harness.replaceCaption("lặp lại");
  harness.mutate();
  await waitForCaptionProcessing();

  const stopped = harness.sendRuntimeMessage({
    type: "transcript:stop"
  });
  assert.equal(stopped.state.recording, false);
  assert.equal(stopped.state.entryCount, 2);

  harness.replaceCaption("không được ghi");
  harness.mutate();
  await waitForCaptionProcessing();

  const exported = harness.sendRuntimeMessage({
    type: "transcript:export"
  });
  assert.equal(
    exported.content.match(/\] lặp lại/g).length,
    2
  );
  assert.doesNotMatch(exported.content, /không được ghi/);
});

test("bắt đầu ghi chụp cả caption đang hiển thị và xuất tên tệp an toàn", async () => {
  const harness = createHarness({ enabled: false });

  harness.setVideo({
    href: "https://www.youtube.com/watch?v=abc-123",
    title: "Tiêu đề: thử / video - YouTube",
    time: 42
  });
  harness.setCaption("Nội dung đang hiển thị");
  harness.mutate();
  await waitForCaptionProcessing();

  const started = harness.sendRuntimeMessage({
    type: "transcript:start"
  });
  assert.equal(started.state.entryCount, 1);

  const exported = harness.sendRuntimeMessage({
    type: "transcript:export"
  });
  assert.match(exported.content, /Tiêu đề: Tiêu đề: thử \/ video/);
  assert.match(exported.content, /\[00:00:42\] Nội dung đang hiển thị/);
  assert.match(exported.filename, /^youtube-phu-de_/);
  assert.match(exported.filename, /abc-123/);
  assert.doesNotMatch(exported.filename, /[:/\\]/);
  assert.match(exported.filename, /\.txt$/);
});

test("đổi video tự dừng bản ghi và không trộn phụ đề của video mới", async () => {
  const harness = createHarness({ enabled: false });

  harness.sendRuntimeMessage({ type: "transcript:start" });
  harness.setCaption("Nội dung video đầu");
  harness.mutate();
  await waitForCaptionProcessing();

  harness.setVideo({
    href: "https://www.youtube.com/watch?v=video-moi",
    title: "Video mới - YouTube",
    time: 2
  });
  harness.replaceCaption("Nội dung video mới");
  harness.mutate();
  await waitForCaptionProcessing();

  const status = harness.sendRuntimeMessage({
    type: "transcript:getState"
  });
  assert.equal(status.state.recording, false);
  assert.equal(status.state.stoppedBecauseVideoChanged, true);

  const exported = harness.sendRuntimeMessage({
    type: "transcript:export"
  });
  assert.match(exported.content, /Nội dung video đầu/);
  assert.doesNotMatch(exported.content, /Nội dung video mới/);
});
