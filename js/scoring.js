/**
 * The preliminary scoring engine and the two derived readouts (age, interview
 * total). Weights are unchanged from the original inline script.
 */

import { skillsList, criteriaList, ENGLISH_LANG_INDEX } from './formSchema.js';
import { readField } from './formState.js';
import { getLang } from './i18n.js';

const SKILL_WEIGHT = { 'ممتاز': 4, 'جيد': 3, 'متوسط': 2, 'يحتاج تحسين': 1 };

const BANDS = [
  {
    min: 80,
    color: 'var(--ok)',
    ar: 'مرشح قوي — يُوصى بمقابلة فورية',
    en: 'Strong Candidate — Recommend Immediate Interview'
  },
  {
    min: 60,
    color: '#3f8f4f',
    ar: 'مرشح جيد — يستحق مقابلة',
    en: 'Good Candidate — Worth Interviewing'
  },
  {
    min: 40,
    color: 'var(--mid)',
    ar: 'مرشح متوسط — يحتاج مراجعة إضافية',
    en: 'Average Candidate — Needs Further Review'
  },
  {
    min: -Infinity,
    color: 'var(--low)',
    ar: 'لا يستوفي المعايير الأساسية حاليًا',
    en: 'Does Not Currently Meet Baseline Criteria'
  }
];

/** Fills the read-only age box from the date of birth. */
export function calcAge() {
  const dob = document.getElementById('dob')?.value;
  const ageEl = document.getElementById('age');
  if (!ageEl) return;

  if (!dob) {
    ageEl.value = '';
    return;
  }

  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return;

  const today = new Date();
  let age = today.getFullYear() - born.getFullYear();
  const monthDelta = today.getMonth() - born.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < born.getDate())) age--;

  ageEl.value = age;
}

/** @returns {number} the HR interview total, out of 90 */
export function calcInterviewTotal() {
  const total = criteriaList.reduce((sum, _criterion, i) => {
    const value = parseFloat(readField(`int_${i}`));
    return Number.isNaN(value) ? sum : sum + value;
  }, 0);

  const el = document.getElementById('interviewTotal');
  if (el) el.textContent = total;

  return total;
}

/**
 * Pure scoring: reads the form, returns a number out of 100. Split out from the
 * rendering so it can be unit tested and reused for a stored score.
 */
export function computeScore() {
  let score = 0;

  // Real estate experience: 15
  if (readField('re_exp') === 'نعم') score += 15;

  // Sales experience: 10 base, plus 2 per year up to a 5-year cap
  if (readField('sales_exp') === 'نعم') {
    score += 10;
    const years = parseFloat(readField('sales_years')) || 0;
    score += Math.min(years, 5) * 2;
  }

  // Self-rated skills, normalised to 20
  let skillSum = 0;
  let skillCount = 0;
  skillsList.forEach((_skill, i) => {
    const rating = readField(`skill_${i}`);
    if (rating) {
      skillSum += SKILL_WEIGHT[rating] ?? 0;
      skillCount += 1;
    }
  });
  if (skillCount > 0) score += (skillSum / (skillCount * 4)) * 20;

  // English level: 10
  const english = readField(`lang_${ENGLISH_LANG_INDEX}`);
  if (english === 'ممتاز') score += 10;
  else if (english === 'جيد') score += 6;
  else if (english === 'أساسي') score += 2;

  // Flexibility: 5 + 5 + 5
  if (readField('accept_kpi') === 'نعم') score += 5;
  if (readField('accept_commission') === 'نعم') score += 5;
  if (readField('weekend_work') === 'نعم') score += 5;

  // Availability: 10
  const joinTime = readField('join_time');
  if (joinTime === 'فورًا') score += 10;
  else if (joinTime === 'خلال أسبوع') score += 7;
  else if (joinTime === 'خلال أسبوعين') score += 4;
  else if (joinTime === 'خلال شهر') score += 2;

  // Commute: 10
  const commute = readField('commute');
  if (commute === 'اقل من 30') score += 10;
  else if (commute === '30-60') score += 5;
  else if (commute === 'اكثر من ساعة') score += 2;

  return Math.min(100, Math.max(0, Math.round(score)));
}

export function bandFor(score) {
  return BANDS.find((band) => score >= band.min);
}

/**
 * Recomputes the score and repaints the panel.
 * @returns {{score: number, recommendation: string}}
 */
export function updateScore() {
  const score = computeScore();
  const band = bandFor(score);

  const numEl = document.getElementById('scoreNum');
  const tagEl = document.getElementById('scoreTag');

  if (numEl) {
    numEl.textContent = score;
    numEl.style.background = band.color;
  }

  if (tagEl) {
    tagEl.style.background = band.color;
    tagEl.setAttribute('data-ar', band.ar);
    tagEl.setAttribute('data-en', band.en);
    tagEl.textContent = getLang() === 'ar' ? band.ar : band.en;
  }

  return { score, recommendation: band.ar };
}
