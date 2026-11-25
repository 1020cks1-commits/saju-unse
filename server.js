import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";
import { calculateFourPillars } from "manseryeok";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/images", express.static(path.join(__dirname, "images")));

const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// 첫 화면(index.html) 바로 보여주기 (public 폴더 없이 작동)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const STEM_INFO = {
  갑: { hanja: "甲", element: "목", yinYang: "양", title: "큰 소나무(갑목)" },
  을: { hanja: "乙", element: "목", yinYang: "음", title: "유연한 화초(을목)" },
  병: { hanja: "丙", element: "화", yinYang: "양", title: "찬란한 태양(병화)" },
  정: { hanja: "丁", element: "화", yinYang: "음", title: "은은한 촛불(정화)" },
  무: { hanja: "戊", element: "토", yinYang: "양", title: "묵직한 태산(무토)" },
  기: { hanja: "己", element: "토", yinYang: "음", title: "비옥한 대지(기토)" },
  경: { hanja: "庚", element: "금", yinYang: "양", title: "단단한 원석(경금)" },
  신: { hanja: "辛", element: "금", yinYang: "음", title: "빛나는 보석(신금)" },
  임: { hanja: "壬", element: "수", yinYang: "양", title: "깊고 넓은 바다(임수)" },
  계: { hanja: "癸", element: "수", yinYang: "음", title: "촉촉한 봄비(계수)" },
};

const BRANCH_INFO = {
  자: { hanja: "子", element: "수", animal: "쥐" },
  축: { hanja: "丑", element: "토", animal: "소" },
  인: { hanja: "寅", element: "목", animal: "호랑이" },
  묘: { hanja: "卯", element: "목", animal: "토끼" },
  진: { hanja: "辰", element: "토", animal: "용" },
  사: { hanja: "巳", element: "화", animal: "뱀" },
  오: { hanja: "午", element: "화", animal: "말" },
  미: { hanja: "未", element: "토", animal: "양" },
  신: { hanja: "申", element: "금", animal: "원숭이" },
  유: { hanja: "酉", element: "금", animal: "닭" },
  술: { hanja: "戌", element: "토", animal: "개" },
  해: { hanja: "亥", element: "수", animal: "돼지" },
};

function parsePillar(koreanPillar) {
  if (!koreanPillar || koreanPillar.length < 2) return null;
  const stem = koreanPillar[0];
  const branch = koreanPillar[1];
  const sInfo = STEM_INFO[stem] || { hanja: "?", element: "토", yinYang: "양" };
  const bInfo = BRANCH_INFO[branch] || { hanja: "?", element: "토", animal: "" };
  return {
    korean: koreanPillar,
    hanja: `${sInfo.hanja}${bInfo.hanja}`,
    stem: { korean: stem, ...sInfo },
    branch: { korean: branch, ...bInfo },
  };
}

function calculateElements(pillars, includeHour) {
  const counts = { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 };
  const active = includeHour
    ? [pillars.year, pillars.month, pillars.day, pillars.hour]
    : [pillars.year, pillars.month, pillars.day];

  for (const p of active) {
    if (!p) continue;
    counts[p.stem.element] = (counts[p.stem.element] || 0) + 1;
    counts[p.branch.element] = (counts[p.branch.element] || 0) + 1;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const distribution = Object.entries(counts).map(([name, count]) => ({
    name,
    count,
    percent: Math.round((count / total) * 100),
  }));

  const sorted = [...distribution].sort((a, b) => b.count - a.count);
  return {
    counts,
    distribution,
    dominant: sorted[0].name,
    lacking: sorted.filter((e) => e.count === 0).map((e) => e.name),
    weakest: sorted[sorted.length - 1].name,
  };
}

const SAJU_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    personaTitle: { type: Type.STRING },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    executiveSummary: { type: Type.STRING },
    personalityAndAptitude: { type: Type.STRING },
    wealthAndCareer: { type: Type.STRING },
    loveAndRelationships: { type: Type.STRING },
    yearlyFlow: { type: Type.STRING },
    questionAnswer: { type: Type.STRING },
    luckyGuide: {
      type: Type.OBJECT,
      properties: {
        colorName: { type: Type.STRING },
        colorHex: { type: Type.STRING },
        numbers: { type: Type.STRING },
        direction: { type: Type.STRING },
        dailyRitual: { type: Type.STRING },
      },
      required: ["colorName", "colorHex", "numbers", "direction", "dailyRitual"],
    },
  },
  required: [
    "personaTitle",
    "keywords",
    "executiveSummary",
    "personalityAndAptitude",
    "wealthAndCareer",
    "loveAndRelationships",
    "yearlyFlow",
    "questionAnswer",
    "luckyGuide",
  ],
};

async function callGeminiWithFlex({ apiKey, model, systemInstruction, prompt, useFlex }) {
  const ai = new GoogleGenAI({ apiKey });
  const baseConfig = {
    systemInstruction,
    responseMimeType: "application/json",
    responseSchema: SAJU_RESPONSE_SCHEMA,
    temperature: 0.75,
  };

  if (useFlex) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { ...baseConfig, serviceTier: "flex", httpOptions: { timeout: 120000 } },
        });
        return { text: response.text, usedTier: "flex" };
      } catch (err) {
        const msg = String(err?.message || err);
        const status = err?.status || err?.code;
        if (status === 400 || msg.includes("400") || msg.includes("not supported")) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { ...baseConfig, httpOptions: { timeout: 90000 } },
  });
  return { text: response.text, usedTier: useFlex ? "standard-fallback" : "standard" };
}

app.post("/api/saju", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.includes("your_gemini")) {
      return res.status(500).json({ error: "클라우드타입 환경변수에 GEMINI_API_KEY를 설정해주세요." });
    }

    const {
      name = "귀하",
      gender = "female",
      year,
      month,
      day,
      hour = 12,
      minute = 0,
      unknownTime = false,
      isLunar = false,
      isLeapMonth = false,
      useTrueSolarTime = true,
      dayBoundary = "midnight",
      focusTopic = "종합운",
      customQuestion = "",
      model = DEFAULT_MODEL,
      useFlex = true,
    } = req.body;

    if (!year || !month || !day) {
      return res.status(400).json({ error: "생년월일을 정확히 입력해주세요." });
    }

    let sajuRaw;
    try {
      sajuRaw = calculateFourPillars({
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: unknownTime ? 12 : Number(hour),
        minute: unknownTime ? 0 : Number(minute),
        isLunar: Boolean(isLunar),
        isLeapMonth: Boolean(isLunar && isLeapMonth),
        gender: gender === "male" ? "male" : "female",
        dayBoundary,
        ...(useTrueSolarTime && !unknownTime
          ? { trueSolarTime: { longitude: 127.5, applyEquationOfTime: true, applyHistoricalDst: true } }
          : {}),
      });
    } catch (calcErr) {
      return res.status(400).json({ error: `날짜 오류: 음력/윤달 여부를 확인해주세요. (${calcErr.message})` });
    }

    const obj = sajuRaw.toObject();
    const pillars = {
      year: parsePillar(obj.year),
      month: parsePillar(obj.month),
      day: parsePillar(obj.day),
      hour: unknownTime ? null : parsePillar(obj.hour),
    };
    const elements = calculateElements(pillars, !unknownTime);
    const tenGods = sajuRaw.tenGods || {};
    const voidBranches = sajuRaw.voidBranches || [];
    const luckPillars = (sajuRaw.luckPillars?.pillars || []).slice(0, 8).map((lp) => ({
      age: lp.age,
      korean: lp.korean || lp.pillar,
      hanja: parsePillar(lp.korean || lp.pillar)?.hanja || "",
    }));

    const currentYear = new Date().getFullYear();
    const approxKoreanAge = currentYear - Number(year) + 1;

    const systemInstruction = `당신은 한국 전통 명리학의 깊은 통찰과 현대 심리 상담의 감각을 겸비한 AI 사주 마스터 '별빛운세정원'입니다. 제공된 만세력 데이터만을 근거로 따뜻하고 현실적인 조언을 한국어로 작성하세요.`;

    const prompt = `
[의뢰인] ${name} / ${gender === "male" ? "남성" : "여성"} / ${isLunar ? (isLeapMonth ? "음력(윤달)" : "음력") : "양력"} ${year}.${month}.${day} ${unknownTime ? "시간미상" : `${hour}:${minute}`} (약 ${approxKoreanAge}세)
[사주원국]
- 연주: ${pillars.year.korean}(${pillars.year.hanja}) 십신(${tenGods.year?.stem || "-"}/${tenGods.year?.branch || "-"})
- 월주: ${pillars.month.korean}(${pillars.month.hanja}) 십신(${tenGods.month?.stem || "-"}/${tenGods.month?.branch || "-"})
- 일주: ${pillars.day.korean}(${pillars.day.hanja}) 일간(${pillars.day.stem.title}) 지지십신(${tenGods.day?.branch || "-"})
- 시주: ${pillars.hour ? `${pillars.hour.korean}(${pillars.hour.hanja}) 십신(${tenGods.hour?.stem || "-"}/${tenGods.hour?.branch || "-"})` : "미상"}
[오행] 목${elements.counts["목"]} 화${elements.counts["화"]} 토${elements.counts["토"]} 금${elements.counts["금"]} 수${elements.counts["수"]} (강한기운:${elements.dominant}, 부족:${elements.lacking.join(",") || elements.weakest})
[공망] ${voidBranches.join(",") || "없음"}
[대운] ${luckPillars.map((l) => `${l.age}세(${l.korean})`).join(" → ")}
[질문] 중점분야: ${focusTopic} / 질문: ${customQuestion.trim() || `${focusTopic} 중심 조언`}
`.trim();

    const { text, usedTier } = await callGeminiWithFlex({
      apiKey,
      model,
      systemInstruction,
      prompt,
      useFlex: Boolean(useFlex),
    });

    const reading = JSON.parse(String(text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
    res.json({
      meta: {
        name,
        gender,
        solarOrLunar: isLunar ? (isLeapMonth ? "음력(윤달)" : "음력") : "양력",
        birthText: `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")} ${unknownTime ? "시간 미상" : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`}`,
        approxKoreanAge,
        model,
        usedTier,
      },
      chart: {
        pillars,
        tenGods,
        voidBranches,
        elements,
        luckPillars: { forward: sajuRaw.luckPillars?.forward ?? true, startAge: sajuRaw.luckPillars?.startAge ?? 1, list: luckPillars },
      },
      reading,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI 사주 분석 중 오류가 발생했습니다. API 키와 모델을 확인해주세요." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✨ 별빛운세정원 AI 사주 서버가 실행되었습니다: http://0.0.0.0:${PORT}`);
});
