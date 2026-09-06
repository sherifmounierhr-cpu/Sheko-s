/**
 * The shape of the form, in one place.
 *
 * Everything downstream -- the generated tables, the scoring engine, the
 * serialiser, the Arabic-labelled export -- reads from here, so adding a skill
 * or an interview criterion is a one-line change.
 */

/**
 * The positions the form accepts applications for.
 *
 * Edit this array to change the dropdown — it is the only place the list
 * lives. `ar` is stored as the answer, so it stays stable no matter which
 * language the applicant filled the form in.
 *
 * 'أخرى' reveals a free-text box (see data-show-when in the markup).
 */
export const positionsList = Object.freeze([
  { ar: 'مستشار مبيعات عقاري', en: 'Property Consultant' },
  { ar: 'كبير مستشاري المبيعات', en: 'Senior Property Consultant' },
  { ar: 'قائد فريق مبيعات', en: 'Sales Team Leader' },
  { ar: 'مدير مبيعات', en: 'Sales Manager' },
  { ar: 'أخصائي تسويق', en: 'Marketing Specialist' },
  { ar: 'أخصائي سوشيال ميديا', en: 'Social Media Specialist' },
  { ar: 'مصمم جرافيك', en: 'Graphic Designer' },
  { ar: 'مصور ومونتير', en: 'Photographer / Video Editor' },
  { ar: 'خدمة عملاء', en: 'Customer Service' },
  { ar: 'موارد بشرية', en: 'Human Resources' },
  { ar: 'محاسب', en: 'Accountant' },
  { ar: 'إداري / سكرتارية', en: 'Admin / Secretary' },
  { ar: 'أخرى', en: 'Other' }
]);

export const skillsList = Object.freeze([
  { ar: 'التواصل', en: 'Communication' },
  { ar: 'المبيعات', en: 'Sales' },
  { ar: 'التفاوض', en: 'Negotiation' },
  { ar: 'إتمام الصفقات', en: 'Closing Deals' },
  { ar: 'خدمة العملاء', en: 'Customer Service' },
  { ar: 'العمل الجماعي', en: 'Teamwork' },
  { ar: 'القيادة', en: 'Leadership' },
  { ar: 'إدارة الوقت', en: 'Time Management' }
]);

export const skillRatings = Object.freeze(['ممتاز', 'جيد', 'متوسط', 'يحتاج تحسين']);

export const langList = Object.freeze([
  { ar: 'العربية', en: 'Arabic' },
  { ar: 'الإنجليزية', en: 'English' }
]);

export const langRatings = Object.freeze(['ممتاز', 'جيد', 'أساسي']);

/** Index of the English row in langList -- the one the score depends on. */
export const ENGLISH_LANG_INDEX = 1;

export const criteriaList = Object.freeze([
  { ar: 'المظهر والاحترافية', en: 'Appearance & Professionalism' },
  { ar: 'مهارات التواصل', en: 'Communication Skills' },
  { ar: 'الثقة بالنفس', en: 'Self Confidence' },
  { ar: 'مستوى النشاط', en: 'Energy Level' },
  { ar: 'إمكانات المبيعات', en: 'Sales Potential' },
  { ar: 'الطموح', en: 'Ambition' },
  { ar: 'الشخصية', en: 'Personality' },
  { ar: 'التوافق مع ثقافة الشركة', en: 'Company Culture Fit' },
  { ar: 'الالتزام', en: 'Commitment' }
]);

/**
 * The applicant's single-value fields.
 *
 * The keys are the input `name` attributes and the source of APPLICANT_FIELDS
 * below; the values are the Arabic column headings the original Google Sheet
 * used, kept as in-place documentation of what each terse field name means.
 */
export const labelMap = Object.freeze({
  position: 'الوظيفة المتقدم إليها',
  position_other: 'وظيفة أخرى (حددها)',
  app_date: 'تاريخ تقديم الطلب',
  source: 'كيف عرفت عنا',
  referrer: 'اسم المُحيل',
  full_name: 'الاسم بالكامل',
  dob: 'تاريخ الميلاد',
  age: 'السن',
  nationality: 'الجنسية',
  marital: 'الحالة الاجتماعية',
  mobile: 'رقم الموبايل',
  whatsapp: 'رقم واتساب',
  email: 'البريد الإلكتروني',
  traveled: 'سافر خارج البلاد',
  travel_countries: 'الدول التي سافر إليها',
  club_member: 'مشترك في نادى',
  club_name: 'اسم النادى',
  health_status: 'الحالة الصحية',
  chronic_disease: 'أمراض مزمنة',
  chronic_details: 'تفاصيل الأمراض المزمنة',
  instagram: 'انستجرام',
  facebook: 'فيسبوك',
  linkedin: 'لينكدإن',
  address: 'العنوان',
  governorate: 'المحافظة',
  city: 'المدينة',
  district: 'المنطقة/الحي',
  lives_with: 'تقيم مع',
  transport: 'وسيلة المواصلات',
  commute: 'وقت الوصول للعمل',
  father_name: 'اسم الأب',
  father_job: 'مهنة الأب',
  father_company: 'نشاط الأب',
  mother_name: 'اسم الأم',
  mother_job: 'مهنة الأم',
  mother_company: 'نشاط الأم',
  brothers_count: 'عدد الإخوة',
  sisters_count: 'عدد الأخوات',
  sibling_order: 'ترتيبه بين الإخوة',
  edu_primary: 'المرحلة الابتدائية',
  edu_prep: 'المرحلة الإعدادية',
  edu_secondary: 'المرحلة الثانوية',
  school_type: 'نوع المدرسة',
  secondary_year: 'سنة تخرج الثانوي',
  university: 'الجامعة',
  faculty: 'الكلية',
  major: 'التخصص',
  grad_year: 'سنة التخرج',
  grade: 'التقدير',
  job1_company: 'الشركة 1',
  job1_title: 'المسمى 1',
  job1_period: 'فترة العمل 1',
  job1_salary: 'آخر راتب 1',
  job1_reason: 'سبب الترك 1',
  job2_company: 'الشركة 2',
  job2_title: 'المسمى 2',
  job2_period: 'فترة العمل 2',
  job2_salary: 'آخر راتب 2',
  job2_reason: 'سبب الترك 2',
  job3_company: 'الشركة 3',
  job3_title: 'المسمى 3',
  job3_period: 'فترة العمل 3',
  job3_salary: 'آخر راتب 3',
  job3_reason: 'سبب الترك 3',
  sales_exp: 'خبرة مبيعات',
  sales_years: 'سنوات خبرة المبيعات',
  prev_re_company: 'شركة عقارية سابقة',
  re_exp: 'خبرة عقارات',
  skills_notes: 'ملاحظات المهارات',
  other_lang_name: 'لغة أخرى',
  expected_salary: 'الراتب المتوقع',
  expected_commission: 'العمولة المتوقعة',
  join_time: 'موعد الانضمام',
  accept_kpi: 'يقبل مؤشرات المبيعات',
  accept_commission: 'يقبل دخل بالعمولة',
  weekend_work: 'متاح للعمل بالويكند',
  career_goal: 'الهدف المهني',
  emg_name: 'اسم جهة الطوارئ',
  emg_relation: 'صلة القرابة',
  emg_phone: 'هاتف جهة الطوارئ',
  declare_name: 'اسم المُقر',
  declare_date: 'تاريخ الإقرار'
});

/** The sibling and course mini-tables are plain repeated inputs. */
const siblingFields = ['name', 'age', 'edu', 'job'].flatMap((suffix) =>
  [1, 2, 3, 4].map((n) => `sib${n}_${suffix}`)
);

const courseFields = ['name', 'org', 'year'].flatMap((suffix) =>
  [1, 2, 3].map((n) => `course${n}_${suffix}`)
);

/**
 * Every input name the applicant owns. These land in applications.answers and
 * are readable by the applicant under RLS.
 */
export const APPLICANT_FIELDS = Object.freeze([
  ...Object.keys(labelMap),
  ...siblingFields,
  ...courseFields,
  ...skillsList.map((_, i) => `skill_${i}`),
  ...langList.map((_, i) => `lang_${i}`)
]);

/**
 * Every input name the HR section owns. These land in application_reviews,
 * a table no applicant has a policy on.
 */
export const HR_FIELDS = Object.freeze([
  ...criteriaList.map((_, i) => `int_${i}`),
  'int_date',
  'int_by',
  'hr_notes',
  'final_decision',
  'final_date',
  'final_notes'
]);

/**
 * Fields the applicant must fill before the form can be submitted.
 *
 * This one list drives both halves of the behaviour: the red asterisk drawn
 * next to each label and the check that runs on submit. Keeping them from a
 * single source is the point — a form that marks a field required but does not
 * enforce it (or worse, the other way round) is how people lose their work.
 *
 * Do not put conditionally shown fields here; a hidden field cannot be filled.
 */
export const REQUIRED_FIELDS = Object.freeze([
  'position',
  'full_name',
  'dob',
  'mobile',
  'email',
  'address',
  'governorate',
  'city',
  'declare_name',
  'declare_date'
]);

export const ROLE_LABELS = Object.freeze({
  applicant: { ar: 'متقدم', en: 'Applicant' },
  hr: { ar: 'موارد بشرية', en: 'HR' },
  admin: { ar: 'مدير النظام', en: 'Admin' }
});
