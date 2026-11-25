import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";
import { calculateFourPillars } from "manseryeok";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use("/images", express.static(path.join(__dirname, "images")));

const PORT = process.env.PORT || 3000;
const FIXED_MODEL = "gemini-3.5-flash-lite";
const JWT_SECRET = process.env.JWT_SECRET || "byeolbit_fallback_secret_2026";
const REQUIRE_CREDITS = process.env.REQUIRE_CREDITS === "true";

// Supabase DB 연결
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 현재 로그인 회원 확인 헬퍼
async function getAuthUser(req) {
  try {
    const token = req.cookies?.byeolbit_token;
    if (!token || !supabase) return null;
    const decoded = jwt.verify(token, JWT_SECRET);
    const { data, error } = await supabase
      .from("users")
      .select("id, kakao_id, nickname, credits")
      .eq("id", decoded.userId)
      .single();
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

function setAuthCookie(req, res, user) {
  const token = jwt.sign({ userId: user.id, nickname: user.nickname }, JWT_SECRET, {
    expiresIn: "30d",
  });
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("byeolbit_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

// ==========================================
// 1. 카카오 로그인 (OAuth 2.0)
// ==========================================
app.get("/auth/kakao", (req, res) => {
  const clientId = process.env.KAKAO_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send("클라우드타입 환경변수에 KAKAO_CLIENT_ID를 설정해주세요.");
  }
  const redirectUri = `${getBaseUrl(req)}/auth/kakao/callback`;
  const kakaoAuthUrl =
    `https://kauth.kakao.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  res.redirect(kakaoAuthUrl);
});

app.get("/auth/kakao/callback", async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code) {
      return res.redirect("/?loginError=cancelled");
    }

    const clientId = process.env.KAKAO_CLIENT_ID;
    const clientSecret = process.env.KAKAO_CLIENT_SECRET;
    const redirectUri = `${getBaseUrl(req)}/auth/kakao/callback`;

    const bodyParams = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: String(code),
    });
    if (clientSecret) bodyParams.append("client_secret", clientSecret);

    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: bodyParams,
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("[카카오 토큰 오류]", tokenData);
      return res.redirect("/?loginError=token");
    }

    const userRes = await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const kakaoUser = await userRes.json();
    const kakaoId = String(kakaoUser.id);
    const nickname =
      kakaoUser.kakao_account?.profile?.nickname ||
      kakaoUser.properties?.nickname ||
      "별빛회원";

    if (!supabase) {
      return res.redirect("/?loginError=db");
    }

    let { data: existingUser } = await supabase
      .from("users")
      .select("id, kakao_id, nickname, credits")
      .eq("kakao_id", kakaoId)
      .single();

    if (!existingUser) {
      const { data: created, error: insertErr } = await supabase
        .from("users")
        .insert({ kakao_id: kakaoId, nickname, credits: 3 })
        .select("id, kakao_id, nickname, credits")
        .single();
      if (insertErr) throw insertErr;
      existingUser = created;
    } else if (existingUser.nickname !== nickname) {
      await supabase.from("users").update({ nickname }).eq("id", existingUser.id);
      existingUser.nickname = nickname;
    }

    setAuthCookie(req, res, existingUser);
    res.redirect("/");
  } catch (err) {
    console.error("[카카오 콜백 오류]", err);
    res.redirect("/?loginError=server");
  }
});

app.get("/api/me", async (req, res) => {
  const user = await getAuthUser(req);
  res.json({ user });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie("byeolbit_token");
  res.json({ ok: true });
});

// ==========================================
// 2. 영구 방문자 수 (Supabase DB 저장)
// ==========================================
let fallbackVisits = Number(process.env.START_VISITS || 78000);

app.post("/api/visit", async (req, res) => {
  try {
    if (supabase) {
      const { data } = await supabase
        .from("site_stats")
        .select("count")
        .eq("id", "visits")
        .single();
      const nextCount = (data?.count ? Number(data.count) : fallbackVisits) + 1;
      await supabase.from("site_stats").upsert({ id: "visits", count: nextCount });
      return res.json({ count: nextCount });
    }
  } catch (err) {
    console.warn("[방문자 수 DB 오류]", err?.message);
  }
  fallbackVisits += 1;
  res.json({ count: fallbackVisits });
});

// ==========================================
// 3. 내 사주 보관함 조회 / 삭제
// ==========================================
app.get("/api/history", async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
  const { data, error } = await supabase
    .from("saju_history")
    .select("id, mode, subject_name, birth_summary, result_json, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: "보관함 조회 실패" });
  res.json({ items: data || [] });
});

app.delete("/api/history/:id", async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
  await supabase
    .from("saju_history")
    .delete()
    .eq("id", Number(req.params.id))
    .eq("user_id", user.id);
  res.json({ ok: true });
});

// ==========================================
// 4. 만세력 계산 & Gemini AI 사주 분석
// ==========================================
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

const LITE_SAJU_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    personaTitle: { type: Type.STRING },
    todayScore: { type: Type.INTEGER },
    todayKeyword: { type: Type.STRING },
    todayFortune: { type: Type.STRING },
    briefSajuSummary: { type: Type.STRING },
    luckyColor: { type: Type.STRING },
    luckyNumber: { type: Type.STRING },
    oneLineAdvice: { type: Type.STRING },
  },
  required: [
    "personaTitle",
    "todayScore",
    "todayKeyword",
    "todayFortune",
    "briefSajuSummary",
    "luckyColor",
    "luckyNumber",
    "oneLineAdvice",
  ],
};

const FULL_SAJU_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    personaTitle: { type: Type.STRING },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    executiveSummary: { type: Type.STRING, description: "사주 전체의 큰 그림과 핵심 총평 (최소 700자 이상)" },
    chartDeepAnalysis: {
      type: Type.STRING,
      description: "조후·억부, 신강/신약, 용신·희신·기신, 지장간·12운성·합충형파해, 공망 정밀 해설 (최소 1,600자 이상, [소제목] 구분)",
    },
    comprehensiveFortune: {
      type: Type.STRING,
      description: "타고난 종합운, 초년·중년·말년 흐름, 잠재력과 리스크 요인 심층 분석 (최소 1,500자 이상, [소제목] 구분)",
    },
    wealthAndInvestment: {
      type: Type.STRING,
      description: "재물 그릇, 근로/사업/투자 적합성, 주식·부동산·현금 전략, 손재 방지법 (최소 1,600자 이상, [소제목] 구분)",
    },
    careerAndJobChange: {
      type: Type.STRING,
      description: "최적 직업군 Top 5, 조직 vs 사업 적합도, 이직·승진 타이밍, 처세술 (최소 1,600자 이상, [소제목] 구분)",
    },
    loveAndRelationships: {
      type: Type.STRING,
      description: "연애 패턴, 일지(배우자궁)와 결혼운, 최고 궁합 vs 피할 유형, 귀인운 (최소 1,500자 이상, [소제목] 구분)",
    },
    newYear2027AndDaewoon: {
      type: Type.STRING,
      description: "10년 대운, 2026 병오년 마무리, 2027 정미년 상반기·하반기 월별 흐름과 중장기 로드맵 (최소 1,800자 이상, [소제목] 구분)",
    },
    questionAnswer: {
      type: Type.STRING,
      description: "선택한 분야와 직접 남긴 질문에 대한 명리학적 근거 기반 행동 지침 (최소 1,000자 이상, [소제목] 구분)",
    },
    luckyGuide: {
      type: Type.OBJECT,
      properties: {
        colorName: { type: Type.STRING },
        colorHex: { type: Type.STRING },
        numbers: { type: Type.STRING },
        direction: { type: Type.STRING },
        luckyItem: { type: Type.STRING },
        dailyRitual: { type: Type.STRING },
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

async function callGeminiWithFlex({ apiKey, model, systemInstruction, prompt, schema, maxTokens, useFlex }) {
  const ai = new GoogleGenAI({ apiKey });
  const baseConfig = {
    systemInstruction,
    responseMimeType: "application/json",
    responseSchema: schema,
    temperature: 0.75,
    maxOutputTokens: maxTokens,
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

    const authUser = await getAuthUser(req);
    const {
      mode = "full",
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

    const isLite = mode === "lite";

    // 추후 유료화 전환(REQUIRE_CREDITS=true) 시 1만자 정밀 풀이는 로그인 & 이용권 확인
    if (!isLite && !authUser) {
      return res.status(401).json({ error: "1만자 정밀 풀이는 카카오 로그인 후 이용하실 수 있습니다." });
    }
    if (!isLite && REQUIRE_CREDITS && authUser.credits <= 0) {
      return res.status(402).json({ error: "보유한 정밀 풀이 이용권이 부족합니다." });
    }
      }
    }

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
    const koreaTodayText = new Date().toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    });

    const systemInstruction = isLite
      ? `당신은 다정하고 명쾌한 사주 상담가 '별빛운세정원'입니다. 오늘은 ${koreaTodayText}입니다. 사주 원국과 오늘의 기운을 바탕으로 '오늘의 운세'와 '핵심 사주 요약'만 알차게 작성해주세요.`
      : `당신은 한국 정통 자평명리학과 현대 심리·재무·커리어 컨설팅을 겸비한 최고 수준의 AI 명리학 대가 '별빛운세정원'입니다.
[절대 작성 원칙]
1. 분량 엄수: 전체 JSON 텍스트의 총합이 반드시 **공백 포함 한국어 10,000자(1만자) 이상**이 되도록 매우 상세하고 깊이 있게 집필하세요.
2. 정통 근거 명시: 제공된 만세력 원국(천간·지지·십신·지장간·12운성·합충형파해·오행·공망·대운)을 직접 인용하며 논리적 근거를 설명하세요.
3. 가독성 구조: 각 항목 안에서는 **[소제목]** 형태로 3~4개 단락을 나누고 줄바꿈(\\n\\n)을 충분히 넣어 작성하세요.
4. 시점 정확성: 현재는 ${currentYear}년(${koreaTodayText})이며, 내년은 2027년 정미년(丁未年)입니다. 2027년 신년운세는 상반기·하반기 및 계절/월별 흐름까지 구체적으로 짚어주세요.`;

    const baseDataText = `
[의뢰인 기본 정보]
- 이름: ${name} / 성별: ${gender === "male" ? "남성" : "여성"} / 약 ${approxKoreanAge}세
- 생년월일: ${isLunar ? (isLeapMonth ? "음력(윤달)" : "음력(평달)") : "양력"} ${year}년 ${month}월 ${day}일 ${unknownTime ? "(시간 미상)" : `${hour}시 ${minute}분`}
- 오늘 한국 날짜: ${koreaTodayText}

[사주 원국]
- 연주: ${pillars.year.korean}(${pillars.year.hanja}) | 십신(${tenGods.year?.stem || "-"}/${tenGods.year?.branch || "-"})
- 월주: ${pillars.month.korean}(${pillars.month.hanja}) | 십신(${tenGods.month?.stem || "-"}/${tenGods.month?.branch || "-"})
- 일주: ${pillars.day.korean}(${pillars.day.hanja}) | 일간=${pillars.day.stem.title} | 지지십신(${tenGods.day?.branch || "-"})
- 시주: ${pillars.hour ? `${pillars.hour.korean}(${pillars.hour.hanja}) | 십신(${tenGods.hour?.stem || "-"}/${tenGods.hour?.branch || "-"})` : "미상(삼주로 분석)"}

[오행] 목:${elements.counts["목"]} 화:${elements.counts["화"]} 토:${elements.counts["토"]} 금:${elements.counts["금"]} 수:${elements.counts["수"]} (강함:${elements.dominant}, 부족:${elements.lacking.join(",") || elements.weakest})
[공망] ${voidBranches.join(", ") || "없음"}
`.trim();

    const prompt = isLite
      ? `${baseDataText}\n\n위 사주 원국을 바탕으로 ${koreaTodayText} 기준의 '오늘의 운세'와 '간단한 핵심 사주 풀이' JSON을 작성해주세요.`
      : `${baseDataText}
[정밀 명리 보조 데이터]
- 지장간: ${JSON.stringify(hiddenStems)}
- 12운성: ${JSON.stringify(twelveStages)}
- 합충형파해: ${JSON.stringify(relations)}
- 대운(${sajuRaw.luckPillars?.forward ? "순행" : "역행"}, 대운수 ${sajuRaw.luckPillars?.startAge ?? "-"}): ${luckPillars.map((l) => `${l.age}세(${l.korean}/${l.hanja})`).join(" → ")}

[의뢰인 중점 관심사]
- 선택한 분야: ${focusTopic}
- 직접 남긴 질문: ${customQuestion.trim() || `${focusTopic}을(를) 포함해 전반적인 인생 전략과 2027년 신년운세를 상세히 알고 싶습니다.`}

위 모든 명리 데이터를 빠짐없이 분석하여 총 1만자 이상의 프리미엄 사주 풀이 JSON을 작성해주세요.`.trim();

    const { text, usedTier } = await callGeminiWithFlex({
      apiKey,
      model: FIXED_MODEL,
      systemInstruction,
      prompt,
      schema: isLite ? LITE_SAJU_SCHEMA : FULL_SAJU_SCHEMA,
      maxTokens: isLite ? 2048 : 24576,
      useFlex: Boolean(useFlex),
    });

    const reading = JSON.parse(String(text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());

    const totalChars = isLite
      ? (reading.todayFortune?.length || 0) + (reading.briefSajuSummary?.length || 0)
      : [
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

    const birthText = `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")} ${
      unknownTime ? "시간 미상" : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    }`;

    const resultPayload = {
      mode: isLite ? "lite" : "full",
      meta: {
        name,
        gender,
        solarOrLunar: isLunar ? (isLeapMonth ? "음력(윤달)" : "음력") : "양력",
        birthText,
        todayText: koreaTodayText,
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
    };

    // 로그인 회원이면 DB 사주 보관함에 자동 저장 (+ 유료 모드일 땐 이용권 차감)
    if (authUser && supabase) {
      await supabase.from("saju_history").insert({
        user_id: authUser.id,
        mode: resultPayload.mode,
        subject_name: name,
        birth_summary: `${resultPayload.meta.solarOrLunar} ${birthText}`,
        result_json: resultPayload,
      });

      if (!isLite && REQUIRE_CREDITS) {
        await supabase
          .from("users")
          .update({ credits: authUser.credits - 1 })
          .eq("id", authUser.id);
      }
    }

    res.json(resultPayload);
  } catch (err) {
    console.error("[/api/saju 오류]", err);
    res.status(500).json({ error: `AI 사주 분석 오류: ${err?.message || "잠시 후 다시 시도해주세요."}` });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✨ 별빛운세정원 AI 사주 서버가 실행되었습니다: http://0.0.0.0:${PORT}`);
});
