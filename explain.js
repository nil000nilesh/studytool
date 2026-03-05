import OpenAI from "openai";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { mode, text, question, language, apiKey } = req.body;

    // API Key — Firestore se client bhejta hai (Vercel env var ki zaroorat nahi)
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) {
      return res.status(401).json({ reply: "API Key missing. Admin settings mein save karein." });
    }

    const client = new OpenAI({ apiKey: key });
    let messages = [];

    let langInstruction = "";
    if (language === "english") {
      langInstruction = "OUTPUT LANGUAGE: Strictly English only. Professional and Academic tone.";
    } else {
      langInstruction = `OUTPUT LANGUAGE RULES:
      1. Explanation Language: Hindi (Devanagari Script). Example: "यह प्रक्रिया बहुत महत्वपूर्ण है..."
      2. Technical Terms: KEEP ALL Financial, Scientific, and Calculative terms in English (Latin Script).
         - DO NOT transliterate: "Balance Sheet" stays "Balance Sheet", "Photosynthesis" stays "Photosynthesis".
         - Example: "Inflation बढ़ने से Economy पर असर पड़ता है."`;
    }

    if (mode === "quiz") {
      messages = [
        {
          role: "system",
          content: `You are an Exam Creator. Create 5 MCQs based on the text.
          ${langInstruction}
          Return ONLY a valid JSON Object: { "questions": [{ "question": "...", "options": ["..."], "answer": "...", "explanation": "..." }] }`,
        },
        { role: "user", content: text },
      ];
    } else if (mode === "summary") {
      messages = [
        {
          role: "system",
          content: `You are an expert Academic Tutor. Summarize the text.
          ${langInstruction}
          Format: **Headline**, **Key Points** (3-4 bullets), **Takeaway**.`,
        },
        { role: "user", content: text },
      ];
    } else if (mode === "explain" || mode === "chat") {
      messages = [
        {
          role: "system",
          content: `You are a friendly AI Tutor.
          ${langInstruction}
          Use provided text as primary source. Use general knowledge if question is outside text. Be encouraging and clear.`,
        },
        {
          role: "user",
          content: mode === "chat"
            ? `Context from PDF:\n${text}\n\nUser Question: ${question}`
            : `Explain this text:\n${text}`,
        },
      ];
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.6,
      response_format: mode === "quiz" ? { type: "json_object" } : { type: "text" },
    });

    let replyText = completion.choices[0].message.content;

    if (mode === "quiz") {
      try {
        const parsed = JSON.parse(replyText);
        if (parsed.questions) replyText = JSON.stringify(parsed.questions);
      } catch (e) { console.error("JSON Parse Error:", e); }
    }

    return res.status(200).json({ reply: replyText });

  } catch (err) {
    console.error("Server Error:", err.message);
    return res.status(500).json({ reply: "Server Error. API Key sahi hai? Check karein." });
  }
}
