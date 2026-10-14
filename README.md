# Grok Token Counter 0.5.2 (không chính thức)

Tiện ích Chrome (Manifest V3) hiện một dải mỏng **bên trong ô chat của grok.com**, sát mép dưới và nằm dưới hàng nút (+, Auto, mic):

```
Grok tuần: 6% (reset sau 5d 23h) [■■|──────]   [■■■|─────] Grok Bot tuần: 24% (reset sau 5d 23h) ↻
```

- **Grok tuần (SuperGrok):** % quỹ dùng hằng tuần, lấy từ API `GetGrokCreditsConfig` của grok.com.
- **Grok Bot tuần:** % đã dùng, lấy ngầm qua WebSocket của grok.com (`wss://grok.com/ws/bot/`: gửi lời chào `protocol_version 1.0.0`, sau đó gọi `bot.usage`). Lấy khi tải trang và mỗi 5 phút, **không cần mở trang Usage**.
  - Nếu không lấy được thì dùng số liệu đọc từ Cài đặt > Usage. Trình đọc này hiểu cả giao diện tiếng Việt lẫn tiếng Anh.
- Thanh màu xanh khi còn ít, vàng từ 75%, đỏ từ 90%. Vạch đen là phần thời gian đã trôi qua của kỳ.
- Rê chuột lên để xem nguồn số liệu, giờ reset chính xác và giờ cập nhật. Nút ↻ để làm mới.
- Nhãn tiếng Việt khi trình duyệt dùng tiếng Việt, ngược lại là tiếng Anh.


> Phiên bản 0.5.2 **không có đếm token**, chỉ có dải mức dùng Grok tuần và Grok Bot tuần. Bản có đếm token là 0.6.3.

**Quyền riêng tư:** chỉ kết nối tới chính grok.com bằng phiên đăng nhập sẵn có. Không gửi dữ liệu đi đâu khác, không telemetry. Số liệu chỉ lưu trong trình duyệt.

## Cài đặt
1. Giải nén `grok-token-counter.zip` ra một thư mục (ví dụ `GrokTokenCounter`).
2. Mở `chrome://extensions` (Edge: `edge://extensions`) và bật **Developer mode** (Chế độ nhà phát triển).
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén) rồi chọn thư mục chứa `manifest.json`.
4. Mở/tải lại https://grok.com.

**Cập nhật:** giải nén đè vào cùng thư mục, bấm ↻ trên thẻ tiện ích ở `chrome://extensions`, rồi tải lại grok.com.

## Gỡ lỗi
Nhật ký mặc định tắt. Để bật, gõ vào Console của grok.com `localStorage.setItem('gtcDebug','1')` rồi tải lại trang. Lọc theo `[GTC-WS]`, `[GTC-NET]` hoặc `[GTC-FIND]`. Tắt bằng `localStorage.removeItem('gtcDebug')`.

## Giới hạn
- API, WebSocket và giao diện của grok.com là nội bộ, có thể thay đổi bất cứ lúc nào. Khi đó dải sẽ báo "chưa có dữ liệu" hoặc "mở Usage để cập nhật".

## Ghi công
- Giao diện dải mức dùng (thanh, vạch thời gian, cách gắn vào ô chat) được chuyển thể từ **Claude Token Counter** (kr1shnasomani, MIT, xem `LICENSE-claude-token-counter`).
- Endpoint credits và cách giải mã lấy từ **Grok Usage Watch** (JoshuaWang2211, MIT, xem `LICENSE-grok-usage-watch`).
