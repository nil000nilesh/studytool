import OpenAI from "openai";

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { mode, text, question, language } = req.body;

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    let messages = [];

    // Language Rules
    let langInstruction = "";
    if (language === "english") {
      langInstruction = "OUTPUT LANGUAGE: Strictly English only. Professional and Academic tone.";
    } else {
      langInstruction = `OUTPUT LANGUAGE RULES:
      1. Explanation Language: Hindi (Devanagari Script). Example: "यह प्रक्रिया बहुत महत्वपूर्ण है..."
      2. Technical Terms: KEEP ALL Financial, Scientific, and Calculative terms in English (Latin Script).
         - DO NOT transliterate terms like "Balance Sheet" to "बैलेंस शीट". Keep it "Balance Sheet".
         - DO NOT translate terms like "Photosynthesis" to "प्रकाश संश्लेषण". Keep it "Photosynthesis".
         - Example Output: "Inflation बढ़ने से Economy पर असर पड़ता है."`;
    }

    // --- 1. QUIZ MODE ---
    if (mode === "quiz") {
      messages = [
        {
          role: "system",
          content: `You are an Exam Creator.
          Task: Create 5 Conceptual Multiple Choice Questions (MCQs) based on the text.
          ${langInstruction}
          STRICT OUTPUT FORMAT:
          Return a valid JSON Object with a key "questions" containing an array of objects.
          Example:
          {
            "questions": [
              {
                "question": "Photosynthesis process mein plants kya use karte hain?",
                "options": ["Oxygen", "Sunlight", "Nitrogen", "Gold"],
                "answer": "Sunlight",
                "explanation": "Plants Sunlight energy use karke apna food banate hain."
              }
            ]
          }
          Note: Question text and Explanation must follow Language Rules above.`,
        },
        { role: "user", content: text },
      ];
    }
    // --- 2. SUMMARY MODE ---
    else if (mode === "summary") {
      messages = [
        {
          role: "system",
          content: `You are an expert Academic Tutor.
          Task: Summarize the text.
          ${langInstruction}
          Format:
             - **Headline:** Short title.
             - **Key Points:** 3-4 bullet points.
             - **Takeaway:** One sentence conclusion.`,
        },
        { role: "user", content: text },
      ];
    }
    // --- 3. EXPLAIN & CHAT MODE ---
    else if (mode === "explain" || mode === "chat") {
      messages = [
        {
          role: "system",
          content: `You are a friendly AI Tutor.
          ${langInstruction}
          INSTRUCTIONS:
          1. Context: Use the provided text hints as your primary source.
          2. External Knowledge: If the user asks something NOT in the text, use your General Knowledge to answer fully.
          3. Style: Be encouraging and clear.`,
        },
        {
          role: "user",
          content:
            mode === "chat"
              ? `Context Hints from PDF:\n${text}\n\nUser Question: ${question}`
              : `Explain this text:\n${text}`,
        },
      ];
    }

    console.log(`☁️ AI Request: ${mode} in ${language}...`);

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.6,
      response_format: mode === "quiz" ? { type: "json_object" } : { type: "text" },
    });

    let replyText = completion.choices[0].message.content;

    // Quiz JSON Handling
    if (mode === "quiz") {
      try {
        const parsed = JSON.parse(replyText);
        if (parsed.questions) {
          replyText = JSON.stringify(parsed.questions);
        }
      } catch (e) {
        console.error("JSON Parse Error:", e);
      }
    }

    return res.status(200).json({ reply: replyText });
  } catch (err) {
    console.error("❌ Server Error:", err.message);
    return res.status(500).json({
      reply: "Server Error: Request fail ho gayi. Check karein ki aapka Internet chal raha hai.",
    });
  }
}
