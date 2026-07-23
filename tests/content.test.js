const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONTENT_SCRIPT = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function createHarness(savedSettings = {}) {
  let captionSegments = [];
  let storageListener = null;
  let cancelCount = 0;
  const observers = [];
  const spoken = [];

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
      return [];
    },
    speak(utterance) {
      spoken.push(utterance);
    }
  };

  const document = {
    body: {},
    documentElement: { lang: "vi" },
    querySelectorAll() {
      return captionSegments;
    }
  };

  const chrome = {
    storage: {
      sync: {
        get(defaults, callback) {
          callback({ ...defaults, ...savedSettings });
        }
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
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
    changeSettings(changes) {
      const storageChanges = Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [key, { newValue: value }])
      );
      storageListener(storageChanges, "sync");
    },
    endSpeech(index) {
      spoken[index].onend();
    },
    failSpeech(index) {
      spoken[index].onerror();
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
  // Includes the 80 ms DOM settle and the 320 ms speech coalescing window.
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

test("không mất caption ngắn khi nó biến mất trước cửa sổ ổn định 80 ms", async () => {
  const harness = createHarness();

  harness.setCaption("A");
  harness.mutate();
  harness.setCaption();
  harness.mutate();
  harness.setCaption("B");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "A");

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "B");
});

test("hai caption khác nhau xuất hiện trong 80 ms vẫn được giữ đúng thứ tự", async () => {
  const harness = createHarness();

  harness.setCaption("caption A");
  harness.mutate();
  harness.replaceCaption("caption B");
  harness.mutate();
  await waitForCaptionSettle();

  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, "caption A");

  harness.endSpeech(0);
  assert.equal(harness.spoken.length, 2);
  assert.equal(harness.spoken[1].text, "caption B");
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
