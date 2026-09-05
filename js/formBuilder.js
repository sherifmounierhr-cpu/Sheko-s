/**
 * Renders the three generated tables (skills, languages, interview criteria).
 *
 * The original built these with innerHTML strings carrying inline onchange
 * attributes. They are built with DOM nodes here instead; change handling is a
 * single delegated listener on the form, wired up in main.js.
 */

import {
  positionsList,
  skillsList,
  skillRatings,
  langList,
  langRatings,
  criteriaList
} from './formSchema.js';

function labelCell(entry) {
  const td = document.createElement('td');
  td.setAttribute('data-ar', entry.ar);
  td.setAttribute('data-en', entry.en);
  td.textContent = entry.ar;
  return td;
}

function radioCell(name, value) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  td.appendChild(input);
  return td;
}

/** Rows are appended after the existing <tr> of headers, which stays put. */
function appendRows(table, rows) {
  if (!table) return;
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => fragment.appendChild(row));
  table.appendChild(fragment);
}

export function renderSkillsTable(table = document.getElementById('skillsTable')) {
  appendRows(
    table,
    skillsList.map((skill, i) => {
      const tr = document.createElement('tr');
      tr.appendChild(labelCell(skill));
      skillRatings.forEach((rating) => tr.appendChild(radioCell(`skill_${i}`, rating)));
      return tr;
    })
  );
}

export function renderLangTable(table = document.getElementById('langTable')) {
  appendRows(
    table,
    langList.map((lang, i) => {
      const tr = document.createElement('tr');
      tr.appendChild(labelCell(lang));
      langRatings.forEach((rating) => tr.appendChild(radioCell(`lang_${i}`, rating)));
      return tr;
    })
  );
}

export function renderInterviewTable(table = document.getElementById('interviewTable')) {
  appendRows(
    table,
    criteriaList.map((criterion, i) => {
      const tr = document.createElement('tr');
      tr.appendChild(labelCell(criterion));

      const scoreCell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '10';
      input.name = `int_${i}`;
      scoreCell.appendChild(input);
      tr.appendChild(scoreCell);

      return tr;
    })
  );
}

/**
 * Fills the "position applied for" dropdown from positionsList.
 *
 * Each option carries an explicit value, so the stored answer stays Arabic
 * even when the applicant switches the interface to English -- the language
 * toggle rewrites option text, and an option without a value attribute would
 * silently change what gets saved.
 */
export function renderPositionsSelect(select = document.querySelector('select[name="position"]')) {
  if (!select) return;

  const fragment = document.createDocumentFragment();

  positionsList.forEach((position) => {
    const option = document.createElement('option');
    option.value = position.ar;
    option.setAttribute('data-ar', position.ar);
    option.setAttribute('data-en', position.en);
    option.textContent = position.ar;
    fragment.appendChild(option);
  });

  select.appendChild(fragment);
}

/** Builds everything generated from the schema. Call once, before hydration. */
export function renderGeneratedTables() {
  renderPositionsSelect();
  renderSkillsTable();
  renderLangTable();
  renderInterviewTable();
}
