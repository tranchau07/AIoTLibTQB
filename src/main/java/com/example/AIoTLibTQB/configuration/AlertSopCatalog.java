package com.example.AIoTLibTQB.configuration;

import com.example.AIoTLibTQB.enums.AlertType;
import com.example.AIoTLibTQB.enums.RoomType;

/**
 * Bảng hướng dẫn quy trình vận hành chuẩn (SOP - Standard Operating Procedure)
 * theo loại sự cố và đặc thù phân khu chức năng thư viện (STUDY_ROOM, BOOK_STORAGE, CIRCULATION_HALL).
 */
public final class AlertSopCatalog {

    private AlertSopCatalog() {
    }

    public static String resolveSop(String metricType, AlertType alertType, RoomType roomType) {
        RoomType rType = roomType != null ? roomType : RoomType.STUDY_ROOM;
        String metric = metricType != null ? metricType : "";

        if ("HUMIDITY_HIGH".equals(metric)) {
            return "SOP Kho sách: Kích hoạt ngay máy hút ẩm công nghiệp về dải 45–55%RH; đóng kín cửa thông gió tự nhiên để ngăn bào tử nấm mốc phát triển trên giấy.";
        }
        if ("HUMIDITY_LOW".equals(metric)) {
            return "SOP Kho sách: Độ ẩm xuống dưới 45%RH dễ làm giòn gãy sợi giấy cổ; kiểm tra hệ thống bù ẩm và giảm lưu lượng gió khô HVAC.";
        }
        if ("NOISE_PEAK".equals(metric)) {
            return switch (rType) {
                case STUDY_ROOM -> "SOP Trật tự: Xuất hiện xung tiếng ồn đột ngột cường độ cao; cán bộ tuần tra kiểm tra khu vực bàn đọc và nhắc nhở giữ yên lặng.";
                case BOOK_STORAGE -> "SOP Kho sách: Kiểm tra hoạt động bốc xếp tài liệu hoặc va chạm kệ sắt trong kho lưu trữ.";
                case CIRCULATION_HALL -> "SOP Sảnh mượn trả: Điều tiết luồng bạn đọc tập trung tại quầy thủ tục; phân luồng sang các bàn tự phục vụ.";
            };
        }
        if ("NOISE_AVG".equals(metric) || alertType == AlertType.NOISE_EXCEEDED) {
            return switch (rType) {
                case STUDY_ROOM -> "SOP Phòng đọc: Độ ồn nền vượt ngưỡng yên tĩnh liên tục; nhắc độc giả chuyển sang phòng học nhóm Tầng 5 nếu có nhu cầu thảo luận.";
                case BOOK_STORAGE -> "SOP Kho sách: Kiểm tra tiếng ồn cơ khí từ quạt thông gió hoặc thiết bị vận chuyển sách.";
                case CIRCULATION_HALL -> "SOP Sảnh mượn trả: Mở thêm quầy hỗ trợ bạn đọc giờ cao điểm để giảm ứ đọng gây ồn tại sảnh.";
            };
        }
        if ("TEMPERATURE".equals(metric)) {
            return switch (rType) {
                case BOOK_STORAGE -> "SOP Bảo quản: Nhiệt độ kho sách vượt ngưỡng an toàn; kiểm tra máy lạnh chính xác (Precision AC) và cách nhiệt tường Tây.";
                case STUDY_ROOM -> "SOP Điều hòa: Hạ nhiệt độ setpoint FCU/AHU thêm 1.5°C và kéo rèm chắn bức xạ mặt trời tại các dãy bàn sát vách kính.";
                case CIRCULATION_HALL -> "SOP Sảnh: Kiểm tra rèm chắn gió (air curtain) tại cửa ra vào chính và tăng công suất làm mát sảnh.";
            };
        }
        if ("PM2_5".equals(metric) || alertType == AlertType.AIR_UNHEALTHY) {
            return "SOP Khí tươi IAQ: Tăng công suất quạt cấp khí tươi có lọc HEPA (AHU), hạn chế mở cửa sổ trực tiếp ra mặt đường Giải Phóng - Trần Đại Nghĩa.";
        }
        if (alertType == AlertType.DEVICE_OFFLINE || "DEVICE_OFFLINE".equals(metric)) {
            return "SOP Kỹ thuật IoT: Kiểm tra nguồn cấp 5V DC của trạm ESP32, tín hiệu Wi-Fi RSSI tại phòng và kết nối MQTT Broker.";
        }
        return "SOP Vận hành: Kiểm tra trực tiếp hiện trường phòng và xác nhận trạng thái thiết bị cảm biến.";
    }
}
