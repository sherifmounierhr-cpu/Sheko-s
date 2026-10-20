// The public job application, section by section. Field names match the
// allow-list in hr_apply() (neon/004_recruitment.sql); the server ignores
// anything else. No health, family-medical or national ID questions.
const YN = ["نعم", "لا"];
export const SKILLS = ["التواصل", "المبيعات", "التفاوض", "إتمام الصفقات", "خدمة العملاء", "العمل الجماعي", "القيادة", "إدارة الوقت"];
export const SKILL_RATINGS = ["ممتاز", "جيد", "متوسط", "يحتاج تحسين"];
export const LANG_RATINGS = ["ممتاز", "جيد", "أساسي"];
export const CRITERIA = ["المظهر والاحترافية", "مهارات التواصل", "الثقة بالنفس", "مستوى النشاط", "إمكانات المبيعات", "الطموح", "الشخصية", "التوافق مع ثقافة الشركة", "الالتزام"];

// f(name, label, type, extra): type is text|tel|email|date|number|select|radio|textarea|check
const f = (name, label, type = "text", extra = {}) => ({ name, label, type, ...extra });

export const SECTIONS = [
  { id: "job", title: "الوظيفة", fields: [
    f("position", "الوظيفة المتقدم ليها", "select", { required: true, options: "positions" }),
    f("position_other", "اكتب الوظيفة", "text", { showWhen: ["position", "أخرى"], required: true }),
    f("source", "عرفت عننا منين؟", "select", { options: ["موقع الشركة", "فيسبوك", "انستجرام", "لينكدإن", "تيك توك", "ترشيح من حد", "أخرى"] }),
    f("referrer", "اسم اللي رشحك", "text", { showWhen: ["source", "ترشيح من حد"] }),
  ] },
  { id: "me", title: "بياناتك", fields: [
    f("full_name", "الاسم بالكامل (رباعي)", "text", { required: true, autocomplete: "name", minlength: 5 }),
    f("dob", "تاريخ الميلاد", "date", { required: true }),
    f("nationality", "الجنسية", "text", { value: "مصري" }),
    f("marital", "الحالة الاجتماعية", "select", { options: ["أعزب / آنسة", "متزوج", "مطلق", "أرمل"] }),
    f("military", "الموقف من التجنيد", "select", { options: ["أدى الخدمة", "معفى", "مؤجل", "لا ينطبق"] }),
    f("mobile", "رقم الموبايل", "tel", { required: true, autocomplete: "tel", dir: "ltr", inputmode: "tel" }),
    f("whatsapp", "رقم الواتساب (لو مختلف)", "tel", { dir: "ltr", inputmode: "tel" }),
    f("email", "الإيميل", "email", { autocomplete: "email", dir: "ltr" }),
    f("linkedin", "لينك لينكدإن", "text", { dir: "ltr" }),
  ] },
  { id: "home", title: "السكن والمواصلات", fields: [
    f("governorate", "المحافظة", "select", { options: ["الإسكندرية", "مطروح", "البحيرة", "القاهرة", "الجيزة", "أخرى"] }),
    f("city", "المدينة", "text", { required: true }),
    f("district", "المنطقة / الحي", "text"),
    f("transport", "بتيجي إزاي؟", "radio", { options: ["عربية خاصة", "مواصلات عامة", "أوبر / كريم", "أخرى"] }),
    f("commute", "توصل الشغل في قد إيه؟", "radio", { options: ["أقل من 30 دقيقة", "من 30 إلى 60 دقيقة", "أكثر من ساعة"] }),
  ] },
  { id: "edu", title: "التعليم", fields: [
    f("university", "الجامعة / المعهد", "text"),
    f("faculty", "الكلية", "text"),
    f("major", "التخصص", "text"),
    f("grad_year", "سنة التخرج", "number", { min: 1970, max: 2035 }),
    f("grade", "التقدير", "select", { options: ["امتياز", "جيد جدًا", "جيد", "مقبول", "لسه بدرس"] }),
    f("course1_name", "كورس أو شهادة (1)", "text"), f("course1_org", "من جهة", "text"),
    f("course2_name", "كورس أو شهادة (2)", "text"), f("course2_org", "من جهة", "text"),
  ] },
  { id: "exp", title: "الخبرة", fields: [
    f("sales_exp", "عندك خبرة في المبيعات؟", "radio", { options: YN }),
    f("sales_years", "كام سنة خبرة مبيعات؟", "number", { min: 0, max: 40, showWhen: ["sales_exp", "نعم"] }),
    f("re_exp", "اشتغلت في العقارات قبل كده؟", "radio", { options: YN }),
    f("prev_re_company", "اسم الشركة العقارية", "text", { showWhen: ["re_exp", "نعم"] }),
    ...[1, 2, 3].flatMap((n) => [
      f(`job${n}_company`, `آخر شغل (${n}): الشركة`, "text", { group: n }),
      f(`job${n}_title`, "المسمى الوظيفي", "text", { group: n }),
      f(`job${n}_period`, "الفترة (من - لحد)", "text", { group: n }),
      f(`job${n}_salary`, "آخر مرتب", "text", { group: n }),
      f(`job${n}_reason`, "سبب ترك الشغل", "text", { group: n, wide: true }),
    ]),
  ] },
  { id: "skills", title: "المهارات واللغات", fields: [
    { type: "grid", name: "skill", label: "قيّم مهاراتك بصراحة", rows: SKILLS, options: SKILL_RATINGS },
    f("skills_notes", "حاجة عايز تضيفها عن مهاراتك", "textarea"),
    { type: "grid", name: "lang", label: "اللغات", rows: ["العربية", "الإنجليزية"], options: LANG_RATINGS },
    f("other_lang_name", "لغة تانية (لو فيه)", "text"),
  ] },
  { id: "terms", title: "التوقعات والإتاحة", fields: [
    f("expected_salary", "المرتب الأساسي المتوقع", "text", { inputmode: "numeric" }),
    f("expected_commission", "العمولة أو الحافز المتوقع", "text"),
    f("join_time", "تقدر تبدأ إمتى؟", "radio", { options: ["فورًا", "خلال أسبوع", "خلال أسبوعين", "خلال شهر"] }),
    f("accept_kpi", "موافق تشتغل بأهداف ومؤشرات مبيعات؟", "radio", { options: YN }),
    f("accept_commission", "موافق على دخل جزء منه بالعمولة؟", "radio", { options: YN }),
    f("weekend_work", "تقدر تشتغل في الإجازات لو احتجنا؟", "radio", { options: YN }),
    f("career_goal", "نفسك توصل لإيه في 3 سنين؟", "textarea"),
  ] },
  { id: "end", title: "الطوارئ والإقرار", fields: [
    f("emg_name", "اسم حد نكلمه في الطوارئ", "text"),
    f("emg_relation", "صلة القرابة", "text"),
    f("emg_phone", "رقم موبايله", "tel", { dir: "ltr", inputmode: "tel" }),
    { type: "file", name: "cv", label: "ارفع الـ CV بتاعك (اختياري: PDF أو Word أو صورة، لحد 3 ميجا)", wide: true },
    f("declare_name", "اكتب اسمك بالكامل كإقرار", "text", { required: true }),
    f("declare_ok", "أقر إن كل البيانات دي صحيحة، وموافق إن Everest تحتفظ بيها لغرض التوظيف بس.", "check", { required: true }),
  ] },
];
export const LABELS = Object.fromEntries(SECTIONS.flatMap((s) => s.fields.flatMap((x) => x.type === "grid" ? x.rows.map((r, i) => [`${x.name}_${i}`, r]) : [[x.name, x.label]])));
