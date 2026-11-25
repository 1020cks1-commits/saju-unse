import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";
import { calculateFourPillars } from "manseryeok";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/images", express.static(path.join(__dirname, "images")));

const PORT = process.env.PORT || 3000;
const FIXED_MODEL = "gemini-3.5-flash-lite";

app.get("/", (req, res) => {
  const VISIT_FILE = path.join(__dirname, "visits.json");
const BASE_VISITS = Number(process.env.START_VISITS || 78000);
let currentVisits = BASE_VISITS;

try {
  if (fs.existsSync(VISIT_FILE)) {
    const saved = JSON.parse(fs.readFileSync(VISIT_FILE, "utf8"));
    if (typeof saved.count === "number" && saved.count >= BASE_VISITS) {
      currentVisits = saved.count;
    }
  }
} catch {}

app.post("/api/visit", (req, res) => {
  currentVisits += 1;
  try {
    fs.writeFileSync(VISIT_FILE, JSON.stringify({ count: currentVisits }));
  } catch {}
  res.json({ count: currentVisits });
});
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
  if (!koreanPillar || typeof koreanPillar !== "string" || koreanPillar.length < 2) return null;
  const stem = koreanPillar[0];
  const branch = koreanPillar[1];
  const sInfo = STEM_INFO[stem] || { hanja: "?", element: "토", yinYang: "양", title: stem };
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

// 1만자 이상 초정밀 명리 리포트를 위한 확장 JSON 스키마
const SAJU_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    personaTitle: {
      type: Type.STRING,
      description: "의뢰인의 일간과 격국을 상징적으로 담은 시적 별칭 (1줄)",
    },
    keywords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "사주의 핵심을 관통하는 키워드 5개 (# 제외)",
    },
    executiveSummary: {
      type: Type.STRING,
      description: "사주 전체의 큰 그림과 핵심 운명 총평 (최소 700자 이상, 줄바꿈 포함)",
    },
    chartDeepAnalysis: {
      type: Type.STRING,
      description:
        "1) 일간과 계절(월지)의 조화(조후·억부), 2) 신강/신약 판별과 용신·희신·기신 도출, 3) 지장간·12운성·합충형파해 작용, 4) 공망과 타고난 그릇 크기에 대한 정밀 명리 해설 (최소 1,600자 이상, [소제목]으로 문단 구분)",
    },
    comprehensiveFortune: {
      type: Type.STRING,
      description:
        "타고난 종합운, 인생의 초년·중년·말년 흐름, 숨겨진 잠재력과 반드시 고쳐야 할 인생의 함정/리스크 요인까지 심층 분석 (최소 1,500자 이상, [소제목]으로 문단 구분)",
    },
    wealthAndInvestment: {
      type: Type.STRING,
      description:
        "1) 타고난 재물 그릇과 재성·식상 구조, 2) 근로소득 vs 사업소득 vs 투자소득 적합성, 3) 주식·코인·부동산·현금 등 자산 배분 전략, 4) 돈이 새는 구멍과 큰 지출/손재를 피하는 시기 및 방법 (최소 1,600자 이상, [소제목]으로 문단 구분)",
    },
    careerAndJobChange: {
      type: Type.STRING,
      description:
        "1) 관성·인성·식상 기반 최적 직업군·직무 Top 5, 2) 대기업/공직 vs 스타트업/전문직 vs 프리랜서/사업 적합도, 3) 이직·승진·창업하기 좋은 시기와 피해야 할 결정, 4) 상사·동료·부하직원과의 직장 내 처세술 (최소 1,600자 이상, [소제목]으로 문단 구분)",
    },
    loveAndRelationships: {
      type: Type.STRING,
      description:
        "1) 내면의 연애 성향과 사랑할 때 나타나는 패턴, 2) 일지(배우자궁)와 합충으로 본 인연의 모습 및 결혼운, 3) 나와 최고의 궁합을 이루는 상대의 기질/오행 vs 피해야 할 유형, 4) 대인관계·귀인운을 넓히는 법 (최소 1,500자 이상, [소제목]으로 문단 구분)",
    },
    newYear2027AndDaewoon: {
      type: Type.STRING,
      description:
        "1) 현재 10년 대운의 전체적 성격과 전환점, 2) 2026년 병오년 하반기 마무리 포인트, 3) 2027년 정미년(丁未年) 신년운세 총평 및 상반기(1~6월)·하반기(7~12월) 월별/분기별 핵심 흐름과 기회·주의할 달, 4) 향후 3~5년 중장기 로드맵 (최소 1,800자 이상, [소제목]으로 문단 구분)",
    },
    questionAnswer: {
      type: Type.STRING,
      description:
        "의뢰인이 선택한 중점 분야와 직접 남긴 고민에 대해 명리학적 근거(십신·합충·세운)를 들어 내리는 명쾌하고 구체적인 행동 지침 (최소 1,000자 이상, [소제목]으로 문단 구분)",
    },
    luckyGuide: {
      type: Type.OBJECT,
      properties: {
        colorName: { type: Type.STRING },
        colorHex: { type: Type.STRING },
        numbers: { type: Type.STRING },
        direction: { type: Type.STRING },
        luckyItem: { type: Type.STRING, description: "부족한 오행을 보완하는 생활 소품/음식/취미" },
        dailyRitual: { type: Type.STRING, description: "오늘부터 바로 실천할 개운 루틴 2~3문장" },
      },
      required: ["colorName", "colorHex", "numbers", "direction", "luckyItem", "dailyRitual"],
    },
  },
  required: [
    "personaTitle",
    "keywords",
    "executiveSummary",
    "chartDeepAnalysis",
    "comprehensiveFortune",
    "wealthAndInvestment",
    "careerAndJobChange",
    "loveAndRelationships",
    "newYear2027AndDaewoon",
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
    maxOutputTokens: 24576,
  };

  if (useFlex) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { ...baseConfig, serviceTier: "flex", httpOptions: { timeout: 180000 } },
        });
        return { text: response.text, usedTier: "flex" };
      } catch (err) {
        const msg = String(err?.message || err);
        const status = err?.status || err?.code;
        console.warn(`[Flex 시도 ${attempt + 1} 실패]`, status, msg);
        if (status === 400 || status === 403 || msg.includes("400") || msg.includes("not supported")) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { ...baseConfig, httpOptions: { timeout: 180000 } },
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
    const hiddenStems = sajuRaw.hiddenStems || null;
    const twelveStages = sajuRaw.twelveStages || null;
    const relations = sajuRaw.relations || null;

    const luckPillars = (sajuRaw.luckPillars?.pillars || []).slice(0, 8).map((lp) => ({
      age: lp.age,
      korean: lp.korean || lp.pillar,
      hanja: parsePillar(lp.korean || lp.pillar)?.hanja || "",
    }));

    const currentYear = new Date().getFullYear();
    const approxKoreanAge = currentYear - Number(year) + 1;

    const systemInstruction = `당신은 한국 정통 자평명리학과 현대 심리·재무·커리어 컨설팅을 겸비한 대한민국 최고 수준의 AI 명리학 대가 '별빛운세정원'입니다.

[절대 작성 원칙]
1. 분량 엄수: 전체 JSON 텍스트의 총합이 반드시 **공백 포함 한국어 10,000자(1만자) 이상**이 되도록 매우 상세하고 깊이 있게 집필하세요. 절대 대충 요약하거나 몇 줄로 얼버무리지 마세요.
2. 정통 근거 명시: 반드시 아래 제공된 만세력 원국(천간·지지·십신·지장간·12운성·합충형파해·오행·공망·대운)을 직접 인용하며 "왜 이런 해석이 나오는지" 논리적 근거를 먼저 설명한 뒤 현실 조언으로 연결하세요.
3. 가독성 구조: 각 항목 안에서는 **[소제목]** 형태로 3~4개 단락을 나누고 줄바꿈(\\n\\n)을 충분히 넣어 읽기 편한 프리미엄 보고서처럼 작성하세요.
4. 시점 정확성: 현재는 ${currentYear}년이며, 내년은 2027년 정미년(丁未年)입니다. 2027년 신년운세는 상반기·하반기 및 계절/월별 흐름까지 구체적으로 짚어주세요.
5. 진정성 있는 톤: 막연한 공포 조장이나 뜬구름 잡는 덕담을 피하고, 실제 20~50대 한국인의 현실(자산, 투자, 이직, 사업, 연애, 인간관계)에 딱 맞는 날카롭고 따뜻한 솔루션을 제공하세요.`;

    const prompt = `
[의뢰인 기본 정보]
- 이름/호칭: ${name}
- 성별: ${gender === "male" ? "남성" : "여성"}
- 출생 일시: ${isLunar ? (isLeapMonth ? "음력(윤달)" : "음력(평달)") : "양력"} ${year}년 ${month}월 ${day}일 ${unknownTime ? "(출생 시각 미상 - 삼주 분석)" : `${hour}시 ${minute}분`}
- 현재 나이: 약 ${approxKoreanAge}세 (${currentYear}년 기준)

[확정 만세력 사주 원국]
- 연주(초년·조상): ${pillars.year.korean}(${pillars.year.hanja}) | 십신: 천간=${tenGods.year?.stem || "-"}, 지지=${tenGods.year?.branch || "-"}
- 월주(청년·사회·부모): ${pillars.month.korean}(${pillars.month.hanja}) | 십신: 천간=${tenGods.month?.stem || "-"}, 지지=${tenGods.month?.branch || "-"}
- 일주(본인·배우자궁): ${pillars.day.korean}(${pillars.day.hanja}) | 일간=${pillars.day.stem.title} | 지지십신=${tenGods.day?.branch || "-"}
- 시주(말년·자식·결실): ${pillars.hour ? `${pillars.hour.korean}(${pillars.hour.hanja}) | 십신: 천간=${tenGods.hour?.stem || "-"}, 지지=${tenGods.hour?.branch || "-"}` : "미상(삼주로 분석, 시주 추측 금지)"}

[오행 분포 및 기운]
- 목(木): ${elements.counts["목"]} / 화(火): ${elements.counts["화"]} / 토(土): ${elements.counts["토"]} / 금(金): ${elements.counts["금"]} / 수(水): ${elements.counts["수"]}
- 가장 강한 오행: ${elements.dominant}
- 부족하거나 없는 오행: ${elements.lacking.length > 0 ? elements.lacking.join(", ") : `${elements.weakest}(약함)`}
- 공망(空亡): ${voidBranches.join(", ") || "없음"}

[정밀 명리 보조 데이터 (지장간 · 12운성 · 합충형파해)]
- 지장간(Hidden Stems): ${JSON.stringify(hiddenStems)}
- 12운성(Twelve Stages): ${JSON.stringify(twelveStages)}
- 합충형파해(Relations): ${JSON.stringify(relations)}

[대운 흐름 (${sajuRaw.luckPillars?.forward ? "순행" : "역행"}, 대운수 ${sajuRaw.luckPillars?.startAge ?? "-"})]
${luckPillars.map((l) => `${l.age}세(${l.korean}/${l.hanja})`).join(" → ")}

[의뢰인 중점 관심사]
- 선택한 분야: ${focusTopic}
- 직접 남긴 질문: ${customQuestion.trim() || `${focusTopic}을(를) 포함해 전반적인 인생 전략과 2027년 신년운세를 아주 상세히 알고 싶습니다.`}

위 모든 명리 데이터를 빠짐없이 분석하여, 각 스키마 항목의 최소 글자수를 충족하는 총 1만자 이상의 압도적인 프리미엄 사주 풀이 JSON을 작성해주세요.
`.trim();

    const { text, usedTier } = await callGeminiWithFlex({
      apiKey,
      model: FIXED_MODEL,
      systemInstruction,
      prompt,
      useFlex: Boolean(useFlex),
    });

    const reading = JSON.parse(String(text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());

    const totalChars = [
      reading.executiveSummary,
      reading.chartDeepAnalysis,
      reading.comprehensiveFortune,
      reading.wealthAndInvestment,
      reading.careerAndJobChange,
      reading.loveAndRelationships,
      reading.newYear2027AndDaewoon,
      reading.questionAnswer,
    ]
      .filter(Boolean)
      .join("").length;

    res.json({
      meta: {
        name,
        gender,
        solarOrLunar: isLunar ? (isLeapMonth ? "음력(윤달)" : "음력") : "양력",
        birthText: `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")} ${unknownTime ? "시간 미상" : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`}`,
        approxKoreanAge,
        model: FIXED_MODEL,
        usedTier,
        totalChars,
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
    console.error("[/api/saju 오류]", err);
    res.status(500).json({ error: `AI 사주 분석 오류: ${err?.message || "잠시 후 다시 시도해주세요."}` });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✨ 별빛운세정원 AI 사주 서버가 실행되었습니다: http://0.0.0.0:${PORT}`);
});
