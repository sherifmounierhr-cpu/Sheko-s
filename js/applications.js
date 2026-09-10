/**
 * Data access for applications and their HR reviews.
 *
 * Every call below runs as the signed-in user. There is no privileged path and
 * no filtering done here for security reasons -- RLS decides what comes back.
 * The `.eq('user_id', ...)` filters are for correctness and bandwidth only.
 */

import { getClient } from './supabaseClient.js';
import { CLIENT_ID } from './config.js';

const APPLICATION_COLUMNS =
  'id, user_id, status, answers, score, recommendation, submitted_at, last_client_id, created_at, updated_at';

const REVIEW_COLUMNS =
  'application_id, scores, interview_total, interview_date, interviewer, hr_notes, ' +
  'final_decision, final_date, final_notes, reviewer_id, last_client_id, updated_at';

/* -------------------------------------------------------------------------- */
/* Applicant side                                                             */
/* -------------------------------------------------------------------------- */

/** @returns {Promise<object|null>} the caller's own application, if any */
export async function fetchMyApplication(userId) {
  const { data, error } = await getClient()
    .from('applications')
    .select(APPLICATION_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Creates or updates the caller's application.
 *
 * user_id is unique, so this is a genuine upsert -- the first autosave inserts,
 * every later one updates, and no client-side "do I have a row yet?" bookkeeping
 * is needed.
 *
 * @param {{userId: string, answers: object, score: number, recommendation: string, status?: 'draft'|'submitted'}} input
 */
export async function saveMyApplication({ userId, answers, score, recommendation, status }) {
  const payload = {
    user_id: userId,
    answers,
    score,
    recommendation,
    last_client_id: CLIENT_ID
  };

  // Omitting status on an autosave leaves a submitted application submitted.
  if (status) payload.status = status;

  const { data, error } = await getClient()
    .from('applications')
    .upsert(payload, { onConflict: 'user_id' })
    .select(APPLICATION_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/* -------------------------------------------------------------------------- */
/* HR side                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every application, newest activity first, with the applicant's profile
 * embedded. Returns an empty list for non-staff -- RLS, not a client check.
 */
export async function listApplications() {
  const { data, error } = await getClient()
    .from('applications')
    .select(
      `${APPLICATION_COLUMNS}, applicant:profiles!applications_user_id_profiles_fkey (id, email, full_name, role)`
    )
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function fetchApplication(applicationId) {
  const { data, error } = await getClient()
    .from('applications')
    .select(APPLICATION_COLUMNS)
    .eq('id', applicationId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** @returns {Promise<object|null>} null for applicants -- they have no policy here */
export async function fetchReview(applicationId) {
  const { data, error } = await getClient()
    .from('application_reviews')
    .select(REVIEW_COLUMNS)
    .eq('application_id', applicationId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * @param {{applicationId: string, reviewerId: string, values: object, interviewTotal: number}} input
 */
export async function saveReview({ applicationId, reviewerId, values, interviewTotal }) {
  const { int_date, int_by, hr_notes, final_decision, final_date, final_notes, ...scores } = values;

  const { data, error } = await getClient()
    .from('application_reviews')
    .upsert(
      {
        application_id: applicationId,
        scores,
        interview_total: interviewTotal,
        interview_date: int_date || null,
        interviewer: int_by || null,
        hr_notes: hr_notes || null,
        final_decision: final_decision || null,
        final_date: final_date || null,
        final_notes: final_notes || null,
        reviewer_id: reviewerId,
        last_client_id: CLIENT_ID
      },
      { onConflict: 'application_id' }
    )
    .select(REVIEW_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/** Flattens a review row back into form field names. */
export function reviewToFields(review) {
  if (!review) return {};

  return {
    ...(review.scores || {}),
    int_date: review.interview_date ?? '',
    int_by: review.interviewer ?? '',
    hr_notes: review.hr_notes ?? '',
    final_decision: review.final_decision ?? '',
    final_date: review.final_date ?? '',
    final_notes: review.final_notes ?? ''
  };
}

/* -------------------------------------------------------------------------- */
/* Admin side                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deletes every application (and, by cascade, every review).
 *
 * The `neq` on a column that is never null is PostgREST's way of saying "all
 * rows" -- it refuses an unfiltered DELETE. RLS still limits this to rows the
 * caller may delete, which for a non-admin is only their own.
 */
/**
 * Deletes one application (and, by cascade, its review).
 *
 * RLS limits DELETE on applications to the caller's own row or an admin, so a
 * plain HR account gets a permission-denied error back rather than a silent
 * no-op -- the UI hides the button from them, but this is the real boundary.
 */
export async function deleteApplication(applicationId) {
  const { error } = await getClient().from('applications').delete().eq('id', applicationId);

  if (error) throw error;
}

export async function deleteAllApplications() {
  const { error, count } = await getClient()
    .from('applications')
    .delete({ count: 'exact' })
    .neq('id', '00000000-0000-0000-0000-000000000000');

  if (error) throw error;
  return count ?? 0;
}
