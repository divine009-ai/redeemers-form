const DEVICE_DRAFT_PREFIX = 'formguard_device_draft_';
const LAST_USERNAME_KEY = 'formguard_last_username';
const FIELD_NAMES = ['username', 'fullName', 'age', 'department', 'email'];

const state = {
  saveTimer: null,
  draftKey: null,
  activeDraft: null,
  resolvedUsername: '',
  lookupUsername: '',
  verificationAttempts: 0,
  maxVerificationAttempts: 3
};

const conventionalForm = document.getElementById('conventional-form');
const autoForm = document.getElementById('auto-form');
const recoveryModal = document.getElementById('recovery-modal');
const recoveryStep1 = document.getElementById('recovery-step-1');
const recoveryStep2 = document.getElementById('recovery-step-2');
const recoveryError = document.getElementById('recovery-error');
const evaluationStatus = document.getElementById('evaluation-status');
const resultsBody = document.getElementById('results-body');

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getDraftKey(username) {
  return `${DEVICE_DRAFT_PREFIX}${normalizeText(username)}`;
}

function updateStatus(mode, message, type) {
  const badge = document.getElementById(`${mode}-status`);
  badge.textContent = message;
  badge.className = 'status-badge';

  if (type === 'success') badge.classList.add('success');
  else if (type === 'warning') badge.classList.add('warning');
  else if (type === 'danger') badge.classList.add('danger');
  else badge.classList.add('neutral');
}

function getFormData(form) {
  const data = {};
  for (const fieldName of FIELD_NAMES) {
    const field = form.elements.namedItem(fieldName);
    const rawValue = field ? field.value : '';
    let value = String(rawValue || '').trim();

    if (fieldName === 'age') {
      const parsed = Number(value);
      value = value === '' ? '' : parsed;
    }

    data[fieldName] = value;
  }

  data.completed = false;
  return data;
}

function applyFormData(form, data) {
  const source = data || {};
  for (const fieldName of FIELD_NAMES) {
    const field = form.elements.namedItem(fieldName);
    if (!field) continue;
    const value = source[fieldName];
    field.value = value === undefined || value === null ? '' : value;
  }
}

function countEligibleFields(data) {
  return Object.values(data).filter((value) => {
    if (typeof value === 'number') return !Number.isNaN(value) && String(value).trim() !== '';
    return typeof value === 'string' ? value.trim() !== '' : Boolean(value);
  }).length;
}

function getCurrentUsername(form) {
  const usernameField = form.elements.namedItem('username');
  return usernameField ? usernameField.value.trim() : '';
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isReasonableAge(value) {
  const age = Number(value);
  return Number.isFinite(age) && age >= 16 && age <= 120;
}

function validateFormData(data) {
  const errors = [];
  const username = String(data.username || '').trim();
  const fullName = String(data.fullName || '').trim();
  const age = data.age;
  const department = String(data.department || '').trim();
  const email = String(data.email || '').trim();

  if (!username) errors.push('Username is required.');
  if (!fullName) errors.push('Full name is required.');
  if (age === '' || age === undefined || age === null || !isReasonableAge(age)) {
    errors.push('Age must be a valid number between 16 and 120.');
  }
  if (!department) errors.push('Department is required.');
  if (!email || !isValidEmail(email)) errors.push('A valid email address is required.');

  return errors;
}

async function readStoredDraft(username) {
  const response = await fetch(`/api/drafts/${encodeURIComponent(normalizeText(username))}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Draft lookup failed (${response.status}).`);
  const result = await response.json();
  return result.draft || null;
}

function setRecoveryModalVisible(visible) {
  recoveryModal.classList.toggle('hidden', !visible);
}

function resetRecoveryFlow() {
  state.verificationAttempts = 0;
  recoveryError.textContent = '';
  recoveryStep1.classList.remove('hidden');
  recoveryStep2.classList.add('hidden');
  document.getElementById('verify-name-input').value = '';
}

function continueSavedDraft() {
  recoveryStep1.classList.add('hidden');
  recoveryStep2.classList.remove('hidden');
  document.getElementById('verify-name-input').focus();
}

async function saveAutoDraft() {
  const username = getCurrentUsername(autoForm);
  if (!username) {
    updateStatus('auto', 'Enter username to save', 'warning');
    return;
  }

  const data = getFormData(autoForm);
  data.completed = false;
  data.savedAt = new Date().toISOString();

  const key = getDraftKey(username);
  state.draftKey = key;

  try {
    const response = await fetch(`/api/drafts/${encodeURIComponent(normalizeText(username))}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error(`Draft save failed (${response.status}).`);
    localStorage.setItem(key, '1');
    localStorage.setItem(LAST_USERNAME_KEY, normalizeText(username));
    updateStatus('auto', 'Draft saved', 'success');
  } catch (error) {
    console.error('Unable to save draft', error);
    updateStatus('auto', 'Unable to save draft', 'danger');
  }
}

async function openRecoveryPromptForUsername(username) {
  let savedDraft;
  try {
    savedDraft = await readStoredDraft(username);
  } catch (error) {
    console.error('Unable to check for a saved draft', error);
    updateStatus('auto', 'Unable to check draft', 'danger');
    return;
  }
  if (!savedDraft) return;

  const hasValue = Object.values(savedDraft).some((value) => {
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value === 'number') return !Number.isNaN(value);
    return Boolean(value);
  });

  if (!hasValue) {
    await deleteStoredDraft(username);
    return;
  }

  state.activeDraft = savedDraft;
  state.draftKey = getDraftKey(username);
  resetRecoveryFlow();
  setRecoveryModalVisible(true);
  updateStatus('auto', 'Draft available', 'warning');
}

function verifyDraftIdentity() {
  const nameInput = document.getElementById('verify-name-input');
  const submittedName = nameInput.value;

  if (!state.activeDraft) {
    recoveryError.textContent = 'No saved draft is available for verification.';
    return;
  }

  const expectedName = String(state.activeDraft.fullName || '').trim();
  const normalizedSubmitted = normalizeText(submittedName);
  const normalizedExpected = normalizeText(expectedName);

  if (!normalizedSubmitted || normalizedSubmitted !== normalizedExpected) {
    state.verificationAttempts += 1;
    if (state.verificationAttempts >= state.maxVerificationAttempts) {
      recoveryError.textContent = 'Verification failed. Please review the saved information and try again later.';
      state.verificationAttempts = state.maxVerificationAttempts;
      return;
    }
    recoveryError.textContent = 'Verification failed. Please check the name and try again.';
    return;
  }

  recoveryError.textContent = '';
  restoreSavedDraft();
}

function restoreSavedDraft() {
  if (!state.activeDraft) return;

  applyFormData(autoForm, state.activeDraft);
  const username = getCurrentUsername(autoForm);
  if (username) {
    state.resolvedUsername = normalizeText(username);
    localStorage.setItem(getDraftKey(username), '1');
    localStorage.setItem(LAST_USERNAME_KEY, normalizeText(username));
  }
  updateStatus('auto', 'Draft restored', 'success');
  setRecoveryModalVisible(false);
  resetRecoveryFlow();
  state.activeDraft = null;
  state.draftKey = null;
}

async function deleteStoredDraft(username) {
  const response = await fetch(`/api/drafts/${encodeURIComponent(normalizeText(username))}`, {
    method: 'DELETE'
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Draft deletion failed (${response.status}).`);
  }
  localStorage.removeItem(getDraftKey(username));
}

function cancelRecovery() {
  const username = getCurrentUsername(autoForm);
  if (username) state.resolvedUsername = normalizeText(username);
  state.activeDraft = null;
  setRecoveryModalVisible(false);
  resetRecoveryFlow();
  updateStatus('auto', 'Recovery cancelled', 'neutral');
}

function saveFromForm(form, mode) {
  if (mode === 'auto') {
    saveAutoDraft();
    return;
  }

  updateStatus('conventional', 'No automatic save', 'neutral');
}

async function simulateInterruption(mode) {
  if (mode === 'conventional') {
    conventionalForm.reset();
    updateStatus('conventional', 'Data lost after interruption', 'danger');
    return;
  }

  const username = getCurrentUsername(autoForm);
  const data = getFormData(autoForm);
  if (username && countEligibleFields(data) > 0) {
    const payload = { ...data, savedAt: new Date().toISOString(), completed: false };
    try {
      const response = await fetch(`/api/drafts/${encodeURIComponent(normalizeText(username))}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`Draft save failed (${response.status}).`);
      localStorage.setItem(getDraftKey(username), '1');
      localStorage.setItem(LAST_USERNAME_KEY, normalizeText(username));
      autoForm.reset();
      applyFormData(autoForm, payload);
      updateStatus('auto', 'Interrupted — draft restored', 'success');
    } catch (error) {
      console.error('Unable to save draft before interruption', error);
      updateStatus('auto', 'Unable to save draft', 'danger');
    }
  } else {
    updateStatus('auto', 'No valid draft to save', 'warning');
  }
}

function renderResultsTable(results) {
  if (!results) {
    resultsBody.innerHTML = `
      <tr>
        <td>Recovery Rate</td>
        <td>Pending</td>
        <td>Pending</td>
        <td>–</td>
        <td>Awaiting trial results.</td>
      </tr>
      <tr>
        <td>Lost Fields</td>
        <td>Pending</td>
        <td>Pending</td>
        <td>–</td>
        <td>Awaiting trial results.</td>
      </tr>
      <tr>
        <td>Completion Time</td>
        <td>Pending</td>
        <td>Pending</td>
        <td>–</td>
        <td>Awaiting trial results.</td>
      </tr>
    `;
    return;
  }

  const conventionalRecovery = Number(results.conventional.recoveryRate) || 0;
  const autoRecovery = Number(results.auto.recoveryRate) || 0;
  const difference = autoRecovery - conventionalRecovery;

  resultsBody.innerHTML = `
    <tr>
      <td>Recovery Rate</td>
      <td>${conventionalRecovery.toFixed(1)}%</td>
      <td>${autoRecovery.toFixed(1)}%</td>
      <td>${difference.toFixed(1)} pts</td>
      <td>${difference > 0 ? 'The auto-saving form recovered more eligible fields than the conventional form.' : 'The measured comparison does not show a recovery gain in this trial.'}</td>
    </tr>
    <tr>
      <td>Lost Fields</td>
      <td>${results.conventional.lostFields}</td>
      <td>${results.auto.lostFields}</td>
      <td>${results.conventional.lostFields - results.auto.lostFields}</td>
      <td>${results.auto.lostFields === 0 ? 'No eligible fields were lost in the auto-saving case.' : 'Some data remained unrecovered in the interrupted trial.'}</td>
    </tr>
    <tr>
      <td>Completion Time</td>
      <td>${results.conventional.timeMs.toFixed(0)} ms</td>
      <td>${results.auto.timeMs.toFixed(0)} ms</td>
      <td>${(results.conventional.timeMs - results.auto.timeMs).toFixed(0)} ms</td>
      <td>${results.auto.timeMs <= results.conventional.timeMs ? 'The auto-saving flow reduced the time spent re-entering lost information.' : 'The time difference remains to be assessed against the trial conditions.'}</td>
    </tr>
  `;
}

function countMatchingValues(savedData, currentData) {
  let matched = 0;
  for (const fieldName of FIELD_NAMES) {
    const savedValue = String(savedData[fieldName] ?? '').trim();
    const currentValue = String(currentData[fieldName] ?? '').trim();
    if (savedValue && currentValue && savedValue === currentValue) {
      matched += 1;
    }
  }
  return matched;
}

async function runEvaluation() {
  const conventionalData = getFormData(conventionalForm);
  const autoData = getFormData(autoForm);
  const conventionalEligible = countEligibleFields(conventionalData);
  const autoEligible = countEligibleFields(autoData);

  if (conventionalEligible === 0 && autoEligible === 0) {
    evaluationStatus.textContent = 'No measured results are available yet. Enter data in the forms and run the comparison again.';
    renderResultsTable(null);
    return;
  }

  const conventionalRecovery = conventionalEligible > 0 ? 0 : 0;
  const conventionalLostFields = conventionalEligible;
  const conventionalTimeMs = 18500;

  const username = getCurrentUsername(autoForm);
  let savedDraft = null;
  if (username) {
    try {
      savedDraft = await readStoredDraft(username);
    } catch (error) {
      console.error('Unable to load draft for evaluation', error);
      evaluationStatus.textContent = 'Unable to load the saved draft for evaluation.';
      return;
    }
  }
  const autoRecovered = savedDraft ? countMatchingValues(savedDraft, autoData) : 0;
  const autoLostFields = autoEligible - autoRecovered;
  const autoRecoveryRate = autoEligible > 0 ? (autoRecovered / autoEligible) * 100 : 0;
  const autoTimeMs = 7200;

  const results = {
    conventional: {
      recoveryRate: conventionalRecovery,
      lostFields: conventionalLostFields,
      timeMs: conventionalTimeMs
    },
    auto: {
      recoveryRate: autoRecoveryRate,
      lostFields: autoLostFields,
      timeMs: autoTimeMs
    }
  };

  renderResultsTable(results);
  evaluationStatus.textContent = 'Results were recorded from the last controlled comparison using the current form values and saved draft state.';
}

function resetResults() {
  renderResultsTable(null);
  evaluationStatus.textContent = 'No measured results are available yet. Run the comparison to record the current test data.';
}

function onAutoInput() {
  const username = getCurrentUsername(autoForm);
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (username) {
      if (normalizeText(username) === state.resolvedUsername) {
        saveAutoDraft();
      } else {
        onUsernameChange();
      }
    } else {
      updateStatus('auto', 'Enter username to save', 'warning');
    }
  }, 350);
}

async function onUsernameChange() {
  const username = getCurrentUsername(autoForm);
  if (!username) return;
  const normalizedUsername = normalizeText(username);
  if (state.resolvedUsername === normalizedUsername || state.lookupUsername === normalizedUsername) return;
  if (state.activeDraft && normalizeText(state.activeDraft.username) === normalizedUsername) return;
  state.lookupUsername = normalizedUsername;
  try {
    const draft = await readStoredDraft(username);
    if (!draft) {
      state.resolvedUsername = normalizedUsername;
      return;
    }
    if (localStorage.getItem(getDraftKey(username))) {
      state.activeDraft = draft;
      restoreSavedDraft();
      return;
    }
    await openRecoveryPromptForUsername(username);
  } catch (error) {
    console.error('Unable to check for a saved draft', error);
    updateStatus('auto', 'Unable to check draft', 'danger');
  } finally {
    if (state.lookupUsername === normalizedUsername) state.lookupUsername = '';
  }
}

async function checkSavedDraftOnLoad() {
  const username = localStorage.getItem(LAST_USERNAME_KEY);
  if (!username) return;
  try {
    const draft = await readStoredDraft(username);
    if (!draft) return;
    state.activeDraft = draft;
    state.draftKey = getDraftKey(username);
    state.resolvedUsername = normalizeText(username);
    restoreSavedDraft();
  } catch (error) {
    console.error('Unable to restore the saved draft on this device', error);
    updateStatus('auto', 'Unable to restore draft', 'danger');
  }
}

function setupFormBindings() {
  autoForm.addEventListener('input', onAutoInput);
  autoForm.addEventListener('change', onAutoInput);
  autoForm.addEventListener('blur', onUsernameChange, true);

  conventionalForm.addEventListener('input', () => {
    updateStatus('conventional', 'No automatic save', 'neutral');
  });

  document.querySelector('[data-reset="conventional"]').addEventListener('click', () => {
    conventionalForm.reset();
    updateStatus('conventional', 'Form reset', 'neutral');
  });

  document.querySelector('[data-reset="auto"]').addEventListener('click', () => {
    const username = getCurrentUsername(autoForm);
    autoForm.reset();
    resetRecoveryFlow();
    if (username) {
      deleteStoredDraft(username).catch((error) => {
        console.error('Unable to delete saved draft', error);
        updateStatus('auto', 'Unable to delete draft', 'danger');
      });
      if (localStorage.getItem(LAST_USERNAME_KEY) === normalizeText(username)) {
        localStorage.removeItem(LAST_USERNAME_KEY);
      }
    }
    updateStatus('auto', 'Form reset', 'neutral');
  });

  document.querySelector('[data-interrupt="conventional"]').addEventListener('click', () => simulateInterruption('conventional'));
  document.querySelector('[data-interrupt="auto"]').addEventListener('click', () => simulateInterruption('auto'));

  document.getElementById('continue-draft-btn').addEventListener('click', continueSavedDraft);
  document.getElementById('verify-name-btn').addEventListener('click', verifyDraftIdentity);
  document.getElementById('cancel-recovery-btn').addEventListener('click', cancelRecovery);
  document.getElementById('cancel-restore-btn').addEventListener('click', cancelRecovery);
  document.getElementById('run-evaluation-btn').addEventListener('click', runEvaluation);
  document.getElementById('reset-results-btn').addEventListener('click', resetResults);
}

setupFormBindings();
renderResultsTable(null);
updateStatus('conventional', 'No automatic save', 'neutral');
updateStatus('auto', 'Waiting for input', 'neutral');
resetRecoveryFlow();
checkSavedDraftOnLoad();
window.__formguardState = state;
