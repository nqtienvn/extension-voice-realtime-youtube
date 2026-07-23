# YouTube Caption Voice

Chrome Extension Manifest V3 đọc chính xác dòng phụ đề đang hiển thị trong YouTube.

## Giọng tiếng Việt

Extension luôn đặt ngôn ngữ đọc là `vi-VN`, chỉ tự động chọn các voice có mã
`vi`/`vi-VN`, và giữ nguyên voice tiếng Việt do người dùng chọn. Tốc độ mặc định
là `1.00×`; cấu hình tùy chỉnh cũ vẫn được giữ, riêng mặc định cũ `1.35×` được
đưa về `1.00×` một lần để lời đọc rõ hơn.

Trước khi phát âm, extension chuẩn hóa dấu tiếng Việt về Unicode NFC, loại ký tự
ẩn, sửa khoảng trắng trước dấu câu, bỏ các cue phi lời nói phổ biến như
`[Âm nhạc]`, và đọc rõ các dạng số liền kề `%`, `₫`, `°C`. Các từ viết tắt,
ngày tháng, phiên bản, URL và ký hiệu có nhiều cách hiểu được giữ nguyên để
không tự ý đổi nghĩa caption.

Khi caption trực tiếp còn đang dựng từng ký tự, deadline chỉ đẩy các từ đã hoàn
chỉnh vào FIFO và giữ lại từ cuối đang thay đổi. Nếu ASR sửa từ cuối khi cụm vẫn
ở trong bộ đệm, bản sửa sẽ thay bản nháp thay vì bị đọc nối thành hai phiên bản.

Từ phiên bản `0.2.4`, cửa sổ theo dõi DOM giảm từ `80` xuống `40 ms`, thời gian
gom cụm ổn định giảm từ `320` xuống `260 ms`, và deadline tiền tố an toàn giảm
từ `900` xuống `550 ms`. Danh sách voice được tải trước từ `document_start`;
khi FIFO có nhiều caption chờ, tốc độ đọc được tăng thích ứng tối đa `30%` để
giảm tụt hậu mà không bỏ nội dung.

## Cài thử

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới thư mục này.
4. Mở một video YouTube, bật CC, sau đó bật **Đọc phụ đề** trong popup extension.

## Độ trễ

Extension không dùng API mạng: `MutationObserver` bắt thay đổi phụ đề rồi gọi thẳng `speechSynthesis` trong content script. Điều này loại bỏ round-trip background/TTS server và thường phát lệnh đọc rất nhanh.

Tuy vậy, không extension nào cam kết âm thanh thực sự bắt đầu dưới 100 ms trên mọi máy; Chrome và hệ điều hành quyết định lịch khởi động giọng nói. Để đạt mức thấp nhất, hãy chọn voice có nhãn **local** trong popup (không có “— mạng”).

Mọi phần chữ mới do YouTube sinh ra đều được lưu vào hàng đợi trong bộ nhớ. Extension chỉ phát mục tiếp theo khi mục hiện tại đã đọc xong (hoặc giọng đọc báo lỗi), nên caption mới không cắt ngang caption cũ.

Khi YouTube nối thêm từ vào cùng một caption, extension chỉ thêm phần mới. Với caption dạng cuộn như `một hai ba` → `hai ba bốn`, phần giao `hai ba` được nhận diện để chỉ xếp `bốn` vào hàng đợi, tránh đọc lặp. Nếu hai caption chỉ có đúng một từ chung ở ranh giới, extension vẫn giữ từ đó để không bỏ nhầm nội dung của một câu mới.

Ở chế độ phụ đề hai dòng, khi dòng dưới được YouTube render lại và đẩy lên dòng trên, extension giữ nguyên mốc chữ đã đọc/đã xếp hàng của dòng đó. Việc đổi vị trí hoặc thay node DOM vì thế không làm dòng đang đọc bị phát lại từ đầu.

Các cập nhật chữ gần nhau được gom thành một cụm trước khi gọi giọng đọc, thay vì tạo một utterance cho từng từ hoặc từng hậu tố. Nhờ đó âm thanh liền mạch hơn; bộ đệm vẫn có giới hạn chờ để caption liên tục không bị giữ vô thời hạn.
