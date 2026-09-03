/**
 * Renders the three generated tables (skills, languages, interview criteria).
 *
 * The original built these with innerHTML strings carrying inline onchange
 * attributes. They are built with DOM nodes here instead; change handling is a
 * single delegated listener on the form, wired up in main.js.
 */

import { skillsList, skillRatings, langList, langRatings, criteriaList } from './formSchema.js';

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

/** Builds all three. Call once, before the first hydration. */
export function renderGeneratedTables() {
  renderSkillsTable();
  renderLangTable();
  renderInterviewTable();
}
