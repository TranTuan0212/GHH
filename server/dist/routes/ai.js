"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiRouter = void 0;
const express_1 = require("express");
exports.aiRouter = (0, express_1.Router)();
const CARD_DETECTION_PROMPT = `Bạn là một chuyên gia thị giác máy tính nhận diện bài Tây (Playing Cards 52 lá).
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

Định dạng JSON bắt buộc theo đúng schema sau (không thêm văn bản ngoài JSON):
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
exports.aiRouter.post('/detect-cards', async (req, res) => {
    const startTime = Date.now();
    try {
        const { imageBase64, provider = 'modelapi', // 'modelapi' | 'gemini'
        apiKey: clientApiKey, baseUrl: clientBaseUrl, model: clientModel } = req.body;
        if (!imageBase64 || typeof imageBase64 !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Thiếu dữ liệu ảnh (imageBase64).'
            });
        }
        // Làm sạch base64 data (loại bỏ prefix nếu có)
        const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9+]+;base64,/, '');
        // =========================================================================
        // LỰA CHỌN 1: API TRUNG GIAN (modelapi.vn hoặc OpenAI-compatible Gateway)
        // =========================================================================
        if (provider === 'modelapi' || (clientBaseUrl && clientBaseUrl.includes('modelapi'))) {
            const apiKey = (clientApiKey && clientApiKey.trim()) || process.env.MODELAPI_KEY || process.env.OPENAI_API_KEY;
            if (!apiKey) {
                return res.status(400).json({
                    success: false,
                    message: 'Chưa nhập API Key cho modelapi.vn. Vui lòng bấm biểu tượng ⚙️/🔑 trên giao diện để nhập Key.'
                });
            }
            const baseUrl = (clientBaseUrl && clientBaseUrl.trim().replace(/\/+$/, '')) || 'https://modelapi.vn/v1';
            const endpoint = `${baseUrl}/chat/completions`;
            const model = (clientModel && clientModel.trim()) || 'gpt-4o-mini';
            const payload = {
                model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: CARD_DETECTION_PROMPT },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${cleanBase64}`
                                }
                            }
                        ]
                    }
                ],
                response_format: { type: 'json_object' },
                temperature: 0.1
            };
            const apiRes = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            });
            const responseData = await apiRes.json();
            if (!apiRes.ok) {
                const errMsg = responseData?.error?.message || responseData?.message || `Lỗi từ ${baseUrl} (${apiRes.status})`;
                return res.status(apiRes.status).json({
                    success: false,
                    message: `Gọi API trung gian thất bại: ${errMsg}`
                });
            }
            const rawText = responseData?.choices?.[0]?.message?.content;
            if (!rawText) {
                return res.status(500).json({
                    success: false,
                    message: 'API trung gian không trả về nội dung text.'
                });
            }
            let parsedResult;
            try {
                parsedResult = JSON.parse(rawText);
            }
            catch {
                const cleaned = rawText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
                parsedResult = JSON.parse(cleaned);
            }
            parsedResult.modelUsed = model;
            parsedResult.providerUsed = 'modelapi.vn';
            return res.json({
                success: true,
                elapsedMs: Date.now() - startTime,
                result: parsedResult
            });
        }
        // =========================================================================
        // LỰA CHỌN 2: GOOGLE GEMINI CHÍNH THỐNG (Ưu tiên model nhỏ, nhẹ & nhanh nhất)
        // =========================================================================
        const apiKey = (clientApiKey && clientApiKey.trim()) || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(400).json({
                success: false,
                message: 'Chưa cấu hình Gemini API Key. Vui lòng bấm biểu tượng ⚙️/🔑 trên giao diện để nhập Key.'
            });
        }
        // Danh sách model xếp theo thứ tự: Siêu nhẹ/Nhanh nhất (Flash-Lite ~800ms) -> Flash (~1.5s) -> Phổ biến
        const modelsToTry = [
            'gemini-3.5-flash-lite',
            'gemini-flash-lite-latest',
            'gemini-3-flash-preview',
            'gemini-3.5-flash',
            'gemini-flash-latest',
            'gemini-2.5-flash',
            'gemini-1.5-flash'
        ];
        const requestBody = {
            contents: [
                {
                    parts: [
                        { text: CARD_DETECTION_PROMPT },
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
        let lastError = null;
        let responseData = null;
        let usedModel = '';
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
                    continue;
                }
                responseData = json;
                usedModel = model;
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
            const cleaned = rawText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
            parsedResult = JSON.parse(cleaned);
        }
        parsedResult.modelUsed = usedModel;
        parsedResult.providerUsed = 'Google Gemini Native';
        return res.json({
            success: true,
            elapsedMs: Date.now() - startTime,
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
