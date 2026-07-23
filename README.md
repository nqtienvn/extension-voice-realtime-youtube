# YouTube Caption Voice

Chrome Extension Manifest V3 đọc chính xác dòng phụ đề đang hiển thị trong YouTube.

## Cài thử

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới thư mục này.
4. Mở một video YouTube, bật CC, sau đó bật **Đọc phụ đề** trong popup extension.

## Độ trễ

Extension không dùng API mạng: `MutationObserver` bắt thay đổi phụ đề rồi gọi thẳng `speechSynthesis` trong content script. Điều này loại bỏ round-trip background/TTS server và thường phát lệnh đọc rất nhanh.

Tuy vậy, không extension nào cam kết âm thanh thực sự bắt đầu dưới 100 ms trên mọi máy; Chrome và hệ điều hành quyết định lịch khởi động giọng nói. Để đạt mức thấp nhất, hãy chọn voice có nhãn **local** trong popup (không có “— mạng”).

Khi YouTube nối thêm từ vào cùng một caption, extension chỉ đọc phần mới, không đọc lại từ đầu. Nó chỉ hủy giọng đang đọc khi YouTube chuyển sang caption khác; tắt “Bỏ câu cũ khi có phụ đề mới” nếu muốn đọc hết từng câu.
