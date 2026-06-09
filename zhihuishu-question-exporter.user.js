// ==UserScript==
// @name         智慧树题库导出助手
// @namespace    https://ai-smart-course-student-pro.zhihuishu.com/
// @version      0.9.1
// @description  从智慧树答题记录/解析页收录题目，清洗乱码与干扰文本，并导出 Markdown 复习文档。
// @homepageURL  https://github.com/Wan-JD/zhihuishu-question-exporter
// @supportURL   https://ifdian.net/a/jd0512
// @match        https://ai-smart-course-student-pro.zhihuishu.com/examPreview/*
// @match        https://ai-smart-course-student-pro.zhihuishu.com/singleCourse/knowledgeStudy/*
// @match        https://ai-smart-course-student-pro.zhihuishu.com/learnPage/*
// @match        https://ai-smart-course-student-pro.zhihuishu.com/masteryHistory/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const EXPORTER_ID = "zhs-question-exporter";
  const PREVIEW_ID = "zhs-question-exporter-preview";
  const BANK_PREFIX = "zhs-question-bank:";
  const COURSE_JOB_PREFIX = "zhs-course-collect-job:";
  const JOB_STEP_DELAY = 4500;
  const JOB_MAX_WAIT = 25000;
  const HISTORY_JOB_KEY = "zhs-history-collect-job";

  const state = {
    includeAnswers: true,
    includeAnalysis: true,
    includeRaw: false,
    addBom: true,
    jobRunning: false,
  };

  const QUESTION_TYPES = /^(单选题|多选题|判断题|填空题|简答题|问答题|计算题|论述题)$/;
  const NOISE_LINES = new Set([
    "AI答题辅导",
    "收藏为薄弱题",
    "重新答题",
    "测试题目",
    "答题卡",
    "知识点练习默认部分",
    "答对",
    "答错",
    "未作答",
    "回答正确～",
    "回答错误～",
    "😔",
    "收起",
    "展开",
    "🥳",
  ]);

  const FEEDBACK_FRAGMENT = /[🥳😔]?\s*回答(?:正确|错误)[~～!！]?(?:可以看看下面的解析哦[~～]?)?/g;

  function cleanRichText(value) {
    let text = (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/<\/?(span|font|p|div|strong|b|i|u|br)[^>]*>/gi, " ");

    // Zhihuishu sometimes renders pasted Word CSS as plain text, for example:
    // font-size:12.0000pt;mso-fareast-font-family:宋体;mso-spacerun:;">题干
    const cssDeclaration = /(?:^|[\s"'<>;])(?:line-height|font-size|font-family|mso-[\w-]+|color|background(?:-color)?|text-align|text-indent|letter-spacing|word-break|white-space|vertical-align|margin|padding)\s*:\s*[^;\n<>"]*;?/gi;
    for (let i = 0; i < 8; i += 1) {
      const next = text.replace(cssDeclaration, " ");
      if (next === text) break;
      text = next;
    }

    return text
      .replace(FEEDBACK_FRAGMENT, " ")
      .replace(/["']?\s*>\s*/g, " ")
      .replace(/^[;"'\s]+/, "")
      .replace(/[;"'\s]+$/, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeLine(value) {
    return cleanRichText(value)
      .replace(/^第\s*(\d+)\s*题$/, "$1、")
      .replace(/^([A-H])\s*[\u3001.．)]\s*$/, "$1.")
      .replace(/^([A-H])\s*[\u3001.．)]\s+/, "$1. ")
      .trim();
  }

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getVisibleLines(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`#${EXPORTER_ID}, #${PREVIEW_ID}, script, style, noscript, svg, canvas`)) {
          return NodeFilter.FILTER_REJECT;
        }
        return normalizeLine(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const lines = [];
    while (walker.nextNode()) {
      const line = normalizeLine(walker.currentNode.nodeValue);
      if (line) lines.push(line);
    }
    return lines;
  }

  function shouldSkipLine(line) {
    if (!line) return true;
    if (NOISE_LINES.has(line)) return true;
    if (/^[\s\-—_]+$/.test(line)) return true;
    if (/^[0-9]+$/.test(line)) return true;
    return false;
  }

  function createQuestion(number, type, firstStemLine) {
    return {
      number: number || "",
      type: type || "",
      stem: firstStemLine ? [firstStemLine] : [],
      options: [],
      answer: "",
      analysis: [],
    };
  }

  function appendToOption(question, text) {
    if (!question.options.length) return false;
    const option = question.options[question.options.length - 1];
    option.text = [option.text, text].filter(Boolean).join(" ");
    return true;
  }

  function isAnalysisLikeAnswerList(line) {
    return /^[A-H](?:\s*[、,，]\s*[A-H])+\s*(?:正确|错误|均|都|是|为|，|,|。|；|;)/.test(line);
  }

  function parseQuestionsFromLines(lines) {
    const questions = [];
    let current = null;
    let pendingType = "";
    let mode = "before";

    function finishCurrent() {
      if (!current) return;
      const hasBody = current.stem.join("").length || current.options.some((option) => option.text) || current.answer || current.analysis.join("").length;
      if (hasBody) questions.push(current);
      current = null;
      mode = "before";
    }

    for (const rawLine of lines) {
      const line = normalizeLine(rawLine);
      if (shouldSkipLine(line)) continue;

      if (QUESTION_TYPES.test(line)) {
        pendingType = line;
        if (current && current.answer) mode = "afterAnswer";
        continue;
      }

      const questionMatch = line.match(/^(\d+)\s*[\u3001.．)]\s*(.*)$/);
      if (questionMatch) {
        finishCurrent();
        current = createQuestion(questionMatch[1], pendingType, questionMatch[2]);
        pendingType = "";
        mode = "stem";
        continue;
      }

      if (!current) continue;

      const analysisMatch = line.match(/^(?:答案解析|解析|试题解析)\s*[:：]?\s*(.*)$/);
      if (analysisMatch) {
        mode = "analysis";
        if (analysisMatch[1]) current.analysis.push(analysisMatch[1]);
        continue;
      }

      const answerMatch = line.match(/^(?:参考答案|正确答案|答案(?!解析))\s*[:：]?\s*(.*)$/);
      if (answerMatch) {
        current.answer = answerMatch[1] || "";
        mode = "answer";
        continue;
      }

      if (isAnalysisLikeAnswerList(line)) {
        current.analysis.push(line);
        mode = "analysis";
        continue;
      }

      const optionMatch = line.match(/^([A-H])\s*[\u3001.．)]\s*(.*)$/);
      if (optionMatch) {
        current.options.push({ label: optionMatch[1], text: optionMatch[2] || "" });
        mode = "option";
        continue;
      }

      if (mode === "answer" && !current.answer) {
        current.answer = line;
      } else if (mode === "analysis") {
        current.analysis.push(line);
      } else if (mode === "option" && appendToOption(current, line)) {
        continue;
      } else {
        current.stem.push(line);
        mode = "stem";
      }
    }

    finishCurrent();
    return questions;
  }

  function extractQuestions() {
    const root = document.querySelector("main") || document.querySelector("#app") || document.body;
    const lines = getVisibleLines(root);
    return {
      lines,
      questions: parseQuestionsFromLines(lines),
    };
  }

  function paragraph(lines) {
    return lines.map(normalizeLine).filter(Boolean).join("\n");
  }

  function questionKey(question) {
    const cleanQuestion = sanitizeQuestion(question);
    const stem = paragraph(cleanQuestion.stem).replace(/\s+/g, "");
    const options = cleanQuestion.options.map((option) => `${option.label}.${normalizeLine(option.text)}`).join("|").replace(/\s+/g, "");
    return `${stem}|${options}`.slice(0, 900);
  }

  function getCourseId() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] === "learnPage") return parts[1] || "unknown-course";
    if (parts[0] === "singleCourse" && parts[1] === "knowledgeStudy") return parts[2] || "unknown-course";
    if (parts[0] === "masteryHistory") return parts[1] || "unknown-course";
    if (parts[0] === "examPreview") return parts[1] || "unknown-course";
    return "unknown-course";
  }

  function getCourseStoragePrefix() {
    return `${BANK_PREFIX}${location.origin}:${getCourseId()}:`;
  }

  function sanitizeQuestion(question) {
    const sanitized = {
      ...question,
      stem: Array.isArray(question.stem) ? question.stem.map(normalizeLine).filter(Boolean) : [],
      options: [],
      answer: normalizeLine(question.answer || ""),
      analysis: Array.isArray(question.analysis) ? question.analysis.map(normalizeLine).filter(Boolean) : [],
    };

    const seenOptionLabels = new Set();

    for (const option of Array.isArray(question.options) ? question.options : []) {
      const label = normalizeLine(option.label || "");
      const text = normalizeLine(option.text || "");
      if (!label || !text) continue;

      const combined = `${label}、${text}`;
      if (isAnalysisLikeAnswerList(combined) || isAnalysisLikeAnswerList(text)) {
        sanitized.analysis.push(text);
        continue;
      }

      if (seenOptionLabels.has(label)) {
        sanitized.analysis.push(text);
        continue;
      }

      seenOptionLabels.add(label);
      sanitized.options.push({ label, text });
    }

    sanitized.analysis = [...new Set(sanitized.analysis)];
    return sanitized;
  }

  function bankKey() {
    return `${getCourseStoragePrefix()}${getDocumentBaseName()}`;
  }

  function legacyBankKey() {
    return `${BANK_PREFIX}${location.origin}:${getDocumentBaseName()}`;
  }

  function loadBank() {
    try {
      const raw = localStorage.getItem(bankKey());
      const legacyRaw = !raw ? localStorage.getItem(legacyBankKey()) : "";
      const source = raw || legacyRaw;
      if (!source) return [];
      const questions = JSON.parse(source);
      return Array.isArray(questions) ? questions.map(sanitizeQuestion) : [];
    } catch (error) {
      return [];
    }
  }

  function saveBank(questions) {
    localStorage.setItem(bankKey(), JSON.stringify(questions));
  }

  function listCourseBanks() {
    const prefix = getCourseStoragePrefix();
    const banks = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      try {
        const questions = JSON.parse(localStorage.getItem(key) || "[]").map(sanitizeQuestion);
        banks.push({ key, name, questions });
      } catch (error) {
        // Ignore broken localStorage entries.
      }
    }
    return banks.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  }

  function mergeQuestions(existing, incoming) {
    const merged = [];
    const indexByKey = new Map();

    for (const question of existing) {
      const cleaned = sanitizeQuestion(question);
      const key = questionKey(cleaned);
      const stored = { ...cleaned, key };
      if (indexByKey.has(key)) {
        const currentIndex = indexByKey.get(key);
        const current = merged[currentIndex];
        merged[currentIndex] = {
          ...current,
          type: current.type || stored.type,
          stem: current.stem && current.stem.length ? current.stem : stored.stem,
          options: current.options && current.options.length ? current.options : stored.options,
          answer: current.answer || stored.answer,
          analysis: current.analysis && current.analysis.length ? current.analysis : stored.analysis,
          collectedAt: current.collectedAt || stored.collectedAt,
          key,
        };
      } else {
        indexByKey.set(key, merged.length);
        merged.push(stored);
      }
    }

    let added = 0;
    let updated = 0;

    for (const question of incoming) {
      const cleaned = sanitizeQuestion(question);
      const key = questionKey(cleaned);
      const stored = { ...cleaned, key, collectedAt: new Date().toISOString() };
      if (!indexByKey.has(key)) {
        indexByKey.set(key, merged.length);
        merged.push(stored);
        added += 1;
        continue;
      }

      const currentIndex = indexByKey.get(key);
      const current = merged[currentIndex];
      const improved = {
        ...current,
        type: current.type || stored.type,
        stem: current.stem && current.stem.length ? current.stem : stored.stem,
        options: current.options && current.options.length ? current.options : stored.options,
        answer: current.answer || stored.answer,
        analysis: current.analysis && current.analysis.length ? current.analysis : stored.analysis,
        collectedAt: current.collectedAt || stored.collectedAt,
      };

      if ((!current.answer && stored.answer) || (!(current.analysis && current.analysis.length) && stored.analysis && stored.analysis.length)) {
        updated += 1;
      }
      merged[currentIndex] = improved;
    }

    return { questions: merged, added, updated };
  }

  function renumberQuestions(questions) {
    return questions.map((question, index) => ({ ...question, number: String(index + 1) }));
  }

  function questionToMarkdown(question, index) {
    const number = question.number || String(index + 1);
    const title = question.type ? `## 第 ${number} 题（${question.type}）` : `## 第 ${number} 题`;
    const parts = [title];

    if (question.stem.length) {
      parts.push(`**题干：**\n\n${paragraph(question.stem)}`);
    }

    if (question.options.length) {
      const options = question.options
        .map((option) => `- ${option.label}. ${normalizeLine(option.text)}`)
        .join("\n");
      parts.push(`**选项：**\n\n${options}`);
    }

    if (state.includeAnswers && question.answer) {
      parts.push(`**参考答案：** ${normalizeLine(question.answer)}`);
    }

    if (state.includeAnalysis && question.analysis.length) {
      parts.push(`**解析：**\n\n${paragraph(question.analysis)}`);
    }

    return parts.join("\n\n");
  }

  function getLessonName() {
    const params = new URLSearchParams(location.search);
    const nodeName = normalizeLine(params.get("nodeName"));
    if (nodeName) return nodeName;

    const headingSelectors = [
      "[class*='nodeName']",
      "[class*='courseName']",
      "[class*='chapter']",
      "[class*='title']",
      "h1",
      "h2",
    ];

    for (const selector of headingSelectors) {
      const element = document.querySelector(selector);
      if (!element || element.closest(`#${EXPORTER_ID}, #${PREVIEW_ID}`)) continue;
      const text = normalizeLine(element.textContent);
      if (text && text.length <= 80 && !/用户脚本|已安装脚本|题目导出/.test(text)) return text;
    }

    return normalizeLine(document.title) || "智慧树题目";
  }

  function textLooksLikeChapter(text) {
    if (!text || text.length > 60) return false;
    if (/^(知识模块|必学\s*\d+\s*\/\s*\d+|题目导出|用户脚本|已安装脚本)$/.test(text)) return false;
    if (/^\d+\s*[\u3001.．)]/.test(text)) return false;
    return true;
  }

  function findChapterName(lessonName) {
    const all = [...document.querySelectorAll("body *")]
      .filter((element) => isVisible(element) && !element.closest(`#${EXPORTER_ID}, #${PREVIEW_ID}`));

    const lessonElement = all.find((element) => {
      const text = normalizeLine(element.textContent);
      return text === lessonName || text.includes(lessonName);
    });

    if (!lessonElement) return "";

    const sidebar = lessonElement.closest("aside, nav, [class*='side'], [class*='catalog'], [class*='chapter'], [class*='directory'], [class*='menu']");
    const scope = sidebar || document.body;
    const scopedElements = [...scope.querySelectorAll("*")]
      .filter((element) => isVisible(element) && !element.closest(`#${EXPORTER_ID}, #${PREVIEW_ID}`));
    const lessonIndex = scopedElements.indexOf(lessonElement);
    const beforeLesson = lessonIndex >= 0 ? scopedElements.slice(0, lessonIndex).reverse() : [];

    for (const element of beforeLesson) {
      const text = normalizeLine(element.textContent);
      if (!textLooksLikeChapter(text)) continue;
      if (text === lessonName || text.includes(lessonName)) continue;

      const style = window.getComputedStyle(element);
      const weight = Number(style.fontWeight) || 400;
      const isHeading = /^(H[1-6])$/.test(element.tagName) || weight >= 600 || /title|chapter|name/i.test(element.className || "");
      if (isHeading) return text;
    }

    return "";
  }

  function getDocumentBaseName() {
    const lessonName = getLessonName();
    const chapterName = findChapterName(lessonName);
    if (chapterName && chapterName !== lessonName) return `${chapterName}-${lessonName}`;
    return lessonName;
  }

  function safeFilename() {
    const rawTitle = getDocumentBaseName();
    const title = rawTitle.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
    return `${title}.md`;
  }

  function buildMarkdown(sourceQuestions) {
    const { lines, questions: pageQuestions } = extractQuestions();
    const questions = sourceQuestions || pageQuestions;
    const title = getDocumentBaseName();
    const exportedAt = new Date().toLocaleString();
    const content = questions.map(questionToMarkdown).join("\n\n---\n\n");

    let markdown = [
      `# ${title}`,
      `来源：${location.href}`,
      `导出时间：${exportedAt}`,
      `题目数量：${questions.length}`,
      "---",
      content || "未识别到题目。请先展开/加载题目和解析，再重新点击导出。",
    ].join("\n\n");

    if (state.includeRaw) {
      markdown += `\n\n---\n\n# 页面原始可见文本\n\n${lines.join("\n")}`;
    }

    return {
      markdown: state.addBom ? `\ufeff${markdown}` : markdown,
      count: questions.length,
    };
  }

  function buildCourseMarkdown() {
    const banks = listCourseBanks();
    const exportedAt = new Date().toLocaleString();
    const total = banks.reduce((sum, bank) => sum + bank.questions.length, 0);
    const courseTitle = normalizeLine(document.title) || "智慧树课程题库";

    const sections = banks.map((bank) => {
      const questions = renumberQuestions(bank.questions);
      const content = questions.map(questionToMarkdown).join("\n\n---\n\n");
      return `# ${bank.name}\n\n题目数量：${questions.length}\n\n${content}`;
    });

    const markdown = [
      `# ${courseTitle}`,
      `来源：${location.origin}`,
      `导出时间：${exportedAt}`,
      `章节数量：${banks.length}`,
      `题目总数：${total}`,
      "---",
      sections.join("\n\n---\n\n") || "还没有收录到任何章节题目。",
    ].join("\n\n");

    return {
      markdown: state.addBom ? `\ufeff${markdown}` : markdown,
      count: total,
      sections: banks.length,
    };
  }

  function safeCourseFilename() {
    const title = (normalizeLine(document.title) || "智慧树课程题库").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
    return `${title}-全课题库.md`;
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function saveAsText(filename, text) {
    if (!window.showSaveFilePicker) {
      downloadText(filename, text);
      setStatus("浏览器不支持选路径，已改为普通下载");
      return;
    }

    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [
        {
          description: "Markdown 文档",
          accept: { "text/markdown": [".md"], "text/plain": [".txt"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    await writable.close();
  }

  async function copyText(text) {
    await navigator.clipboard.writeText(text.replace(/^\ufeff/, ""));
  }

  function getElementSnapshot(element) {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      className: String(element.className || "").slice(0, 160),
      text: normalizeLine(element.innerText || element.textContent).slice(0, 220),
      href: element.href || "",
      role: element.getAttribute("role") || "",
      title: element.getAttribute("title") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function findClickableByText(patterns) {
    const elements = [...document.querySelectorAll("button, a, [role='button'], div, span")]
      .filter((element) => isVisible(element) && !element.closest(`#${EXPORTER_ID}, #${PREVIEW_ID}`));

    return elements.find((element) => {
      const text = normalizeLine(element.innerText || element.textContent);
      if (!text || text.length > 80) return false;
      return patterns.some((pattern) => pattern.test(text));
    });
  }

  function scanCourseLessons() {
    const elements = [...document.querySelectorAll(".section-item-collapse-info")]
      .filter((element) => isVisible(element) && !element.closest(`#${EXPORTER_ID}, #${PREVIEW_ID}`));
    const lessons = [];
    const seen = new Set();

    for (const element of elements) {
      const raw = normalizeLine(element.innerText || element.textContent);
      if (!raw || raw.length > 120 || !/必学\s*\d+\s*\/\s*\d+/.test(raw)) continue;

      const text = raw.replace(/\s*必学\s*\d+\s*\/\s*\d+\s*$/, "").trim();
      if (!text) continue;
      if (/^(知识模块|题目导出|收录本页|清空题库|另存为|下载|复制|预览|登录|注册|客服)$/.test(text)) continue;

      const chapterElement = element.closest(".el-collapse-item");
      const chapterText = normalizeLine(chapterElement?.querySelector(".el-collapse-item__header, [class*='header']")?.innerText || "");
      const chapter = chapterText.replace(/^知识模块\s*/, "").trim();

      const key = `${chapter}-${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lessons.push({
        chapter,
        lesson: text,
        displayName: chapter && chapter !== text ? `${chapter}-${text}` : text,
        element: getElementSnapshot(element),
      });
    }

    return lessons;
  }

  async function copyCourseDiagnostics() {
    const lessons = scanCourseLessons();
    const clickable = [...document.querySelectorAll("a, button, [role='button'], div, span")]
      .filter((element) => isVisible(element) && !element.closest(`#${EXPORTER_ID}, #${PREVIEW_ID}`))
      .map(getElementSnapshot)
      .filter((item) => item.text)
      .slice(0, 260);

    const data = {
      url: location.href,
      title: document.title,
      lessonCount: lessons.length,
      lessons,
      clickable,
      bodyTextHead: (document.body.innerText || "").split("\n").map(normalizeLine).filter(Boolean).slice(0, 180),
    };

    await copyText(JSON.stringify(data, null, 2));
    setStatus(`已复制诊断：${lessons.length} 个小节`);
  }

  function downloadCourseBank() {
    const { markdown, count, sections } = buildCourseMarkdown();
    downloadText(safeCourseFilename(), markdown);
    setStatus(`已下载全课题库：${sections} 节，${count} 题`);
  }

  async function saveCourseBank() {
    const { markdown, count, sections } = buildCourseMarkdown();
    try {
      await saveAsText(safeCourseFilename(), markdown);
      setStatus(`已保存全课题库：${sections} 节，${count} 题`);
    } catch (error) {
      if (error && error.name === "AbortError") setStatus("已取消保存");
      else setStatus("保存失败，请改用下载");
    }
  }

  function getHistoryJob() {
    try {
      const raw = sessionStorage.getItem(HISTORY_JOB_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function setHistoryJob(job) {
    sessionStorage.setItem(HISTORY_JOB_KEY, JSON.stringify(job));
  }

  function clearHistoryJob() {
    sessionStorage.removeItem(HISTORY_JOB_KEY);
  }

  function findVisibleButtonText(text) {
    return [...document.querySelectorAll("button, a, [role='button'], div, span")]
      .filter((element) => isVisible(element) && !element.closest(`#${EXPORTER_ID}, #${PREVIEW_ID}`))
      .find((element) => normalizeLine(element.innerText || element.textContent) === text);
  }

  function currentDetailMatchesLesson(lessonName) {
    const middle = document.querySelector(".middle-section") || document.body;
    const text = normalizeLine(middle.innerText || middle.textContent);
    return text.includes(lessonName);
  }

  function findVisiblePromoteButton(lessonName = "") {
    if (lessonName && !currentDetailMatchesLesson(lessonName)) return null;
    const direct = [...document.querySelectorAll(".simplified-mastery__action")]
      .filter((element) => isVisible(element) && !element.closest(`#${EXPORTER_ID}, #${PREVIEW_ID}`))
      .filter((element) => normalizeLine(element.innerText || element.textContent) === "去提升");
    if (direct.length) return direct[direct.length - 1];
    return findVisibleButtonText("去提升");
  }

  function clickElement(element) {
    if (!element) return false;
    element.scrollIntoView({ block: "nearest", inline: "center" });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    };
    element.dispatchEvent(new PointerEvent("pointerover", eventOptions));
    element.dispatchEvent(new PointerEvent("pointerenter", eventOptions));
    element.dispatchEvent(new MouseEvent("mouseover", eventOptions));
    element.dispatchEvent(new MouseEvent("mouseenter", eventOptions));
    element.dispatchEvent(new PointerEvent("pointerdown", eventOptions));
    element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    element.dispatchEvent(new PointerEvent("pointerup", { ...eventOptions, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0 }));
    element.click();
    element.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0 }));
    return true;
  }

  async function clickAndWaitPath(element, pathPart, label) {
    const beforeUrl = location.href;
    clickElement(element);
    const changed = await waitUntilReady(() => {
      const urlChanged = location.href !== beforeUrl;
      return location.pathname.includes(pathPart) || (urlChanged && location.href.includes(pathPart));
    }, label);
    return Boolean(changed);
  }

  function getRecruitId() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (location.pathname.includes("/learnPage/")) {
      return parts[3] || "";
    }
    if (parts[0] === "singleCourse" && parts[1] === "knowledgeStudy") return parts[3] || "";
    if (parts[0] === "masteryHistory") return parts[2] || "";
    if (parts[0] === "examPreview") return parts[5] || "";
    return "";
  }

  function getCurrentNodeId() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] === "learnPage") return parts[2] || "";
    if (parts[0] === "singleCourse" && parts[1] === "knowledgeStudy") return "";
    if (parts[0] === "masteryHistory") return parts[3] || "";
    if (parts[0] === "examPreview") return parts[4] || "";
    return "";
  }

  function openMasteryHistoryDirect(lessonName) {
    const courseId = getCourseId();
    const recruitId = getRecruitId();
    const nodeId = getCurrentNodeId();
    if (!courseId || courseId === "unknown-course" || !recruitId || !nodeId) {
      setStatus("无法识别课程参数，请先进入具体小节页面");
      return;
    }
    const params = new URLSearchParams(location.search);
    params.set("catalogActiveTab", "personal");
    params.set("isFreeExam", "0");
    params.set("nodeName", btoa(encodeURIComponent(JSON.stringify(lessonName || getLessonName()))));
    location.href = `${location.origin}/masteryHistory/${courseId}/${recruitId}/${nodeId}?${params.toString()}`;
  }

  function clickLessonByName(lessonName) {
    const candidates = [...document.querySelectorAll(".section-item-collapse-info")].filter(isVisible);
    const target = candidates.find((element) => normalizeLine(element.innerText || element.textContent).startsWith(lessonName));
    if (!target) return false;
    target.click();
    return true;
  }

  async function startHistoryCollectAll() {
    expandAllCourseModules(false);
    await sleep(1200);
    const lessons = scanCourseLessons();
    if (!lessons.length) {
      setStatus("未扫描到小节，请先展开目录");
      return;
    }

    const job = {
      mode: "lesson",
      lessons,
      lessonIndex: 0,
      historyIndex: 0,
      returnUrl: location.href,
      startedAt: new Date().toISOString(),
    };
    setHistoryJob(job);
    setStatus(`开始历史收录：${lessons.length} 个小节`);
    runHistoryJob();
  }

  function expandAllCourseModules(showStatus = true) {
    const headers = [...document.querySelectorAll(".el-collapse-item__header")]
      .filter((element) => isVisible(element) && !/is-active/.test(element.className || ""));
    headers.forEach((header) => clickElement(header));
    if (showStatus) setStatus(`已尝试展开 ${headers.length} 个模块`);
  }

  function stopHistoryCollectAll() {
    clearHistoryJob();
    setStatus("已停止历史收录");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitUntilReady(check, label) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < JOB_MAX_WAIT) {
      const result = check();
      if (result) return result;
      setStatus(`等待${label}... ${Math.ceil((Date.now() - startedAt) / 1000)}s`);
      await sleep(700);
    }
    return null;
  }

  function scheduleHistoryJob(delay = JOB_STEP_DELAY) {
    if (!getHistoryJob()) return;
    setTimeout(runHistoryJob, delay);
  }

  async function runHistoryJob() {
    if (state.jobRunning) return;
    const job = getHistoryJob();
    if (!job) return;
    state.jobRunning = true;

    try {
    if (location.pathname.includes("/learnPage/") || location.pathname.includes("/singleCourse/knowledgeStudy/")) {
      const lesson = job.lessons[job.lessonIndex];
      if (!lesson) {
        clearHistoryJob();
        setStatus("历史收录完成，可下载全课题库");
        return;
      }

      clickLessonByName(lesson.lesson);
      setStatus(`进入 ${job.lessonIndex + 1}/${job.lessons.length}: ${lesson.displayName}`);
      await waitUntilReady(() => currentDetailMatchesLesson(lesson.lesson), "小节详情切换");
      await sleep(1800);
      openMasteryHistoryDirect(lesson.lesson);
      return;
    }

    if (location.pathname.includes("/masteryHistory/")) {
      const buttons = await waitUntilReady(
        () => {
          const found = [...document.querySelectorAll("button, a, [role='button'], div, span")]
            .filter((element) => isVisible(element) && normalizeLine(element.innerText || element.textContent) === "查看解析");
          return found.length ? found : null;
        },
        "历史解析列表"
      );

      if (!buttons || job.historyIndex >= buttons.length) {
        job.lessonIndex += 1;
        job.historyIndex = 0;
        setHistoryJob(job);
        location.href = job.returnUrl;
        return;
      }

      setStatus(`查看解析 ${job.historyIndex + 1}/${buttons.length}`);
      const enteredPreview = await clickAndWaitPath(buttons[job.historyIndex], "/examPreview/", "解析页跳转");
      if (!enteredPreview) {
        clearHistoryJob();
        setStatus("点击查看解析后未进入解析页，已暂停");
        return;
      }
      scheduleHistoryJob();
      return;
    }

    if (location.pathname.includes("/examPreview/")) {
      const readyQuestions = await waitUntilReady(() => {
        const { questions } = extractQuestions();
        return questions.length ? questions : null;
      }, "题目渲染");
      if (!readyQuestions) {
        setStatus("题目等待超时，本页未收录，返回历史页");
        history.back();
        scheduleHistoryJob();
        return;
      }
      const result = collectCurrentPage();
      const nextJob = getHistoryJob() || job;
      nextJob.historyIndex += 1;
      setHistoryJob(nextJob);
      setStatus(`已收录解析页，新增 ${result.added} 题`);
      history.back();
      await waitUntilReady(() => location.pathname.includes("/masteryHistory/"), "返回历史页");
      scheduleHistoryJob();
    }
    } finally {
      state.jobRunning = false;
    }
  }

  function setStatus(text) {
    const status = document.querySelector(`#${EXPORTER_ID} .zhs-status`);
    if (status) status.textContent = text;
  }

  function collectCurrentPage() {
    const { questions } = extractQuestions();
    const bank = loadBank();
    const result = mergeQuestions(bank, questions);
    saveBank(result.questions);
    setStatus(`本页 ${questions.length} 题，新增 ${result.added} 题，题库共 ${result.questions.length} 题`);
    return result;
  }

  function clearBank() {
    const total = loadBank().length;
    if (!total) {
      setStatus("本节题库已经是空的");
      return;
    }
    if (!confirm(`确定清空本节已收录的 ${total} 个题目吗？`)) return;
    localStorage.removeItem(bankKey());
    refreshCount();
  }

  function refreshCount() {
    const { questions } = extractQuestions();
    const bank = loadBank();
    setStatus(`本页 ${questions.length} 题，题库已收录 ${bank.length} 题`);
  }

  function createButton(label, onClick, primary) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.className = "primary";
    button.addEventListener("click", onClick);
    return button;
  }

  function showPreview() {
    const oldPreview = document.getElementById(PREVIEW_ID);
    if (oldPreview) oldPreview.remove();

    const { markdown, count } = buildMarkdown();
    const preview = document.createElement("div");
    preview.id = PREVIEW_ID;
    preview.innerHTML = `
      <div class="zhs-preview-box">
        <div class="zhs-preview-head">
          <strong>导出预览（${count} 题）</strong>
          <button type="button" aria-label="关闭">×</button>
        </div>
        <textarea readonly></textarea>
      </div>
    `;
    preview.querySelector("textarea").value = markdown.replace(/^\ufeff/, "");
    preview.querySelector("button").addEventListener("click", () => preview.remove());
    document.body.appendChild(preview);
  }

  function mountPanel() {
    if (document.getElementById(EXPORTER_ID)) return;

    const style = document.createElement("style");
    style.textContent = `
      #${EXPORTER_ID} {
        position: fixed;
        right: 16px;
        bottom: 18px;
        z-index: 2147483647;
        width: 260px;
        padding: 12px;
        background: #ffffff;
        color: #172033;
        border: 1px solid #d9dee8;
        border-radius: 8px;
        box-shadow: 0 10px 30px rgba(14, 23, 38, 0.18);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${EXPORTER_ID} .zhs-title {
        margin: 0 0 8px;
        font-weight: 700;
        font-size: 14px;
      }
      #${EXPORTER_ID} .zhs-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 10px;
      }
      #${EXPORTER_ID} button,
      #${PREVIEW_ID} button {
        height: 32px;
        border: 1px solid #cfd6e3;
        border-radius: 6px;
        background: #f7f9fc;
        color: #172033;
        cursor: pointer;
        font: inherit;
      }
      #${EXPORTER_ID} button:hover,
      #${PREVIEW_ID} button:hover {
        background: #eef3fb;
      }
      #${EXPORTER_ID} button.primary {
        background: #2563eb;
        border-color: #2563eb;
        color: #ffffff;
      }
      #${EXPORTER_ID} button.primary:hover {
        background: #1d4ed8;
      }
      #${EXPORTER_ID} .zhs-status {
        min-height: 18px;
        margin-top: 8px;
        color: #52606d;
      }
      #${PREVIEW_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(15, 23, 42, 0.4);
        display: grid;
        place-items: center;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${PREVIEW_ID} .zhs-preview-box {
        width: min(900px, calc(100vw - 48px));
        height: min(720px, calc(100vh - 48px));
        background: #ffffff;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 18px 60px rgba(15, 23, 42, 0.24);
        display: grid;
        grid-template-rows: 48px 1fr;
      }
      #${PREVIEW_ID} .zhs-preview-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        border-bottom: 1px solid #e2e8f0;
      }
      #${PREVIEW_ID} textarea {
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        border: 0;
        padding: 14px;
        resize: none;
        outline: none;
        color: #111827;
        font: 13px/1.6 Consolas, "Microsoft YaHei", monospace;
      }
    `;

    const panel = document.createElement("div");
    panel.id = EXPORTER_ID;
    panel.innerHTML = `
      <div class="zhs-title">题目导出 Plus</div>
      <div class="zhs-actions"></div>
      <div class="zhs-status">先展开所有题目和解析</div>
    `;

    const actions = panel.querySelector(".zhs-actions");
    if (location.pathname.includes("/singleCourse/knowledgeStudy/") || location.pathname.includes("/learnPage/")) {
      actions.appendChild(createButton("扫描目录", () => {
        const lessons = scanCourseLessons();
        setStatus(`扫描到 ${lessons.length} 个小节`);
      }, true));
      actions.appendChild(createButton("开始历史收录", startHistoryCollectAll));
      actions.appendChild(createButton("停止收录", stopHistoryCollectAll));
      actions.appendChild(createButton("复制诊断", copyCourseDiagnostics));
      actions.appendChild(createButton("保存全课", saveCourseBank));
      actions.appendChild(createButton("下载全课", downloadCourseBank));
    }

    if (location.pathname.includes("/examPreview/")) {
      actions.appendChild(createButton("收录本页", collectCurrentPage, true));
      actions.appendChild(createButton("清空题库", clearBank));
    }

    if (location.pathname.includes("/masteryHistory/")) {
      actions.appendChild(createButton("继续历史收录", runHistoryJob, true));
      actions.appendChild(createButton("停止收录", stopHistoryCollectAll));
      actions.appendChild(createButton("保存全课", saveCourseBank));
      actions.appendChild(createButton("下载全课", downloadCourseBank));
    }

    actions.appendChild(createButton("另存为...", async () => {
      const bank = loadBank();
      const exportQuestions = bank.length ? renumberQuestions(bank) : undefined;
      const { markdown, count } = buildMarkdown(exportQuestions);
      try {
        await saveAsText(safeFilename(), markdown);
        setStatus(`已保存 ${count} 个题目${bank.length ? "（题库）" : "（本页）"}`);
      } catch (error) {
        if (error && error.name === "AbortError") setStatus("已取消保存");
        else setStatus("保存失败，请改用下载");
      }
    }));
    actions.appendChild(createButton("下载", () => {
      const bank = loadBank();
      const exportQuestions = bank.length ? renumberQuestions(bank) : undefined;
      const { markdown, count } = buildMarkdown(exportQuestions);
      downloadText(safeFilename(), markdown);
      setStatus(`已下载 ${count} 个题目${bank.length ? "（题库）" : "（本页）"}`);
    }));
    actions.appendChild(createButton("复制", async () => {
      const bank = loadBank();
      const exportQuestions = bank.length ? renumberQuestions(bank) : undefined;
      const { markdown, count } = buildMarkdown(exportQuestions);
      try {
        await copyText(markdown);
        setStatus(`已复制 ${count} 个题目${bank.length ? "（题库）" : "（本页）"}`);
      } catch (error) {
        setStatus("复制失败，请用下载");
      }
    }));
    actions.appendChild(createButton("预览", () => {
      const bank = loadBank();
      if (bank.length) {
        const { markdown, count } = buildMarkdown(renumberQuestions(bank));
        const oldPreview = document.getElementById(PREVIEW_ID);
        if (oldPreview) oldPreview.remove();
        const preview = document.createElement("div");
        preview.id = PREVIEW_ID;
        preview.innerHTML = `
          <div class="zhs-preview-box">
            <div class="zhs-preview-head">
              <strong>题库预览（${count} 题）</strong>
              <button type="button" aria-label="关闭">×</button>
            </div>
            <textarea readonly></textarea>
          </div>
        `;
        preview.querySelector("textarea").value = markdown.replace(/^\ufeff/, "");
        preview.querySelector("button").addEventListener("click", () => preview.remove());
        document.body.appendChild(preview);
        return;
      }
      showPreview();
    }));

    document.head.appendChild(style);
    document.body.appendChild(panel);
    setTimeout(refreshCount, 700);
    if (getHistoryJob()) setTimeout(runHistoryJob, JOB_STEP_DELAY);
  }

  function bootWhenReady() {
    if (!document.body) {
      requestAnimationFrame(bootWhenReady);
      return;
    }
    mountPanel();
  }

  function installRouteWatcher() {
    if (window.__zhsQuestionExporterRouteWatcher) return;
    window.__zhsQuestionExporterRouteWatcher = true;

    const notify = () => {
      setTimeout(() => {
        if (!document.getElementById(EXPORTER_ID)) mountPanel();
        if (getHistoryJob()) runHistoryJob();
      }, JOB_STEP_DELAY);
    };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      notify();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      notify();
      return result;
    };
    window.addEventListener("popstate", notify);
  }

  installRouteWatcher();
  bootWhenReady();
})();
