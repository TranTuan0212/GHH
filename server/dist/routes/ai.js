"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiRouter = void 0;
const express_1 = require("express");
exports.aiRouter = (0, express_1.Router)();
exports.aiRouter.post('/detect-cards', async (req, res) => {
    const startTime = Date.now();
    try {
        const { imageBase64, apiKey: clientApiKey } = req.body;
        if (!imageBase64 || typeof imageBase64 !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Thiếu dữ liệu ảnh (imageBase64).'
            });
        }
        // Ưu tiên key do client gửi từ giao diện, nếu không có thì lấy biến môi trường server
        const apiKey = (clientApiKey && clientApiKey.trim()) || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(400).json({
                success: false,
                message: 'Chưa cấu hình Gemini API Key. Vui lòng bấm biểu tượng ⚙️ trên thanh công cụ để nhập API Key hoặc đặt GEMINI_API_KEY trong file .env trên server.'
            });
        }
        // Làm sạch base64 data (loại bỏ prefix "data:image/jpeg;base64,")
        const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9+]+;base64,/, '');
        const promptText = `Bạn là một chuyên gia thị giác máy tính nhận diện bài Tây (Playing Cards 52 lá).
Hãy phân tích hình ảnh và nhận diện chính xác TẤT CẢ các lá bài tây xuất hiện trong hình.

Các quy tắc nhận diện:
1. Giá trị lá bài (rank):
   - A (Át), 2, 3, 4, 5, 6, 7, 8, 9, 10, J (Bồi), Q (Đầm), K (Già).
2. Chất bài (suit):
   - Cơ (Hearts): màu đỏ, ký hiệu ♥ (suit: "Cơ", suitEn: "HEART", symbol: "♥", color: "red")
   - Rô (Diamonds): màu đỏ hình thoi, ký hiệu ♦ (suit: "Rô", suitEn: "DIAMOND", symbol: "♦", color: "red")
   - Tép/Chuồn (Clubs): màu đen hình cỏ 3 lá, ký hiệu ♣ (suit: "Tép", suitEn: "CLUB", symbol: "♣", color: "black")
   - Bích (Spades): màu đen hình mũi giáo, ký hiệu ♠ (suit: "Bích", suitEn: "SPADE", symbol: "♠", color: "black")
3. Thứ tự xuất hiện:
   - Sắp xếp các lá bài lần lượt theo thứ tự từ TRÁI sang PHẢI (left to right) như trong ảnh chụp.
   - Nếu bài xếp chồng hoặc xòe ra, liệt kê theo thứ tự từ trên xuống hoặc từ trái qua phải.
   - Nếu không thấy lá bài nào rõ ràng, trả về mảng "cards": [].

Định dạng JSON bắt buộc theo schema sau:
{
  "totalCards": 3,
  "summary": "A♠, K♦, 10♥",
  "cards": [
    {
      "rank": "A",
      "suit": "Bích",
      "suitEn": "SPADE",
      "symbol": "♠",
      "code": "AS",
      "display": "A♠",
      "color": "black",
      "confidence": "high"
    }
  ],
  "note": "Ghi chú nếu có"
}`;
        const requestBody = {
            contents: [
                {
                    parts: [
                        { text: promptText },
                        {
                            inline_data: {
                                mime_type: 'image/jpeg',
                                data: cleanBase64
                            }
                        }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.1,
                response_mime_type: 'application/json'
            }
        };
        // Thử gọi gemini-1.5-flash trước, nếu lỗi thì thử gemini-2.0-flash hoặc gemini-2.5-flash
        const modelsToTry = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'];
        let lastError = null;
        let responseData = null;
        for (const model of modelsToTry) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
                const apiRes = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody)
                });
                const json = await apiRes.json();
                if (!apiRes.ok) {
                    lastError = json?.error?.message || `Lỗi từ Google Gemini (${apiRes.status})`;
                    console.warn(`[AI Route] Model ${model} thất bại:`, lastError);
                    continue; // thử model tiếp theo nếu có lỗi về quota/model
                }
                responseData = json;
                break;
            }
            catch (err) {
                lastError = err?.message || err;
                console.warn(`[AI Route] Gọi ${model} thất bại:`, err);
            }
        }
        if (!responseData) {
            return res.status(502).json({
                success: false,
                message: `Gọi Gemini API thất bại: ${lastError || 'Không nhận được phản hồi'}`
            });
        }
        const rawText = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) {
            return res.status(500).json({
                success: false,
                message: 'Gemini không trả về nội dung text.'
            });
        }
        let parsedResult;
        try {
            parsedResult = JSON.parse(rawText);
        }
        catch {
            // Fallback nếu JSON bị bọc markdown ```json ... ```
            const cleaned = rawText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
            parsedResult = JSON.parse(cleaned);
        }
        const elapsedMs = Date.now() - startTime;
        return res.json({
            success: true,
            elapsedMs,
            result: parsedResult
        });
    }
    catch (error) {
        console.error('[AI Route] Lỗi nhận diện bài:', error);
        return res.status(500).json({
            success: false,
            message: error?.message || 'Lỗi server khi nhận diện lá bài.'
        });
    }
});
