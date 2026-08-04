import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyQuickReply,
  bestOwner,
  buildAnswerPrompt,
  currentQuestion,
  followUpQuestion,
  draftedBulletsSchema,
  findGaps,
  needsFollowUp,
  verifyDraft,
  ids,
  profileSchema,
  progress,
  repliesFor,
  DRAFTED_BULLETS_JSON_SCHEMA,
  INTERVIEW_SYSTEM_PROMPT,
  type Gap,
  type Profile,
} from '../../index';
import { applyMerge, planMerge, summarizeMerge } from '../../parse';
import { useActiveProvider } from '../store';

/**
 * The interview, as a conversation.
 *
 * Filling a profile by hand is the slowest and dullest part of using this. The
 * alternative is a short exchange where each question is the most informative
 * one available — which only works because the ranking is computed rather than
 * improvised, so the model is only ever writing prose and reading a reply.
 *
 * Two things keep it from feeling like a form with chat styling:
 *
 *   - Every question offers a tap that resolves with no model call. Saying "no"
 *     is instant. Only replies that add something wait on anything.
 *   - The count of what is left is recomputed from the gaps still open, so it
 *     drops by more than one when a single answer settles several questions.
 */

type Entry =
  | { kind: 'question'; id: string; gap: Gap; text: string }
  | { kind: 'answer'; id: string; text: string }
  | { kind: 'result'; id: string; text: string; detail?: string[] };

export function InterviewPanel({
  profile,
  onProfile,
  onDone,
}: {
  profile: Profile;
  onProfile(next: Profile, note: string): void;
  onDone(): void;
}) {
  const { provider, config, ready } = useActiveProvider();
  const [log, setLog] = useState<Entry[]>([]);
  const [answered, setAnswered] = useState(0);
  const [floor, setFloor] = useState<number | undefined>(undefined);
  const [typed, setTyped] = useState('');
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [followedUp, setFollowedUp] = useState<string[]>([]);
  // While a follow-up is pending, the question must not move. Gaps recompute
  // from the profile on every change, so without pinning, answering the
  // follow-up recorded it against whichever gap had floated to the top —
  // asking about one thing and filing the answer under another.
  const [pinned, setPinned] = useState<Gap | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const openGaps = useMemo(
    // `exclude` rather than filtering the result: the cap has to apply to
    // questions still worth asking, or skipping one shrinks the queue instead
    // of revealing the next.
    () => findGaps(profile, { limit: 12, exclude: skipped }),
    [profile, skipped],
  );
  const current = currentQuestion(pinned, openGaps);
  const stats = progress(openGaps.length, answered, floor);
  // `prompt` is set while a follow-up is waiting on a typed answer. The taps
  // that settle a question outright stay available through it — see repliesFor.
  const replies = current ? repliesFor(current, Boolean(prompt)) : [];

  // Ask the next question whenever one comes up that has not been asked. A
  // pinned question is already on screen with its follow-up.
  useEffect(() => {
    if (!current || pinned) return;
    setLog((entries) =>
      entries.some((e) => e.kind === 'question' && e.gap.id === current.id)
        ? entries
        : [...entries, { kind: 'question', id: `q-${current.id}`, gap: current, text: current.why }],
    );
  }, [current, pinned]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log, busy]);

  const say = (entry: Entry) => setLog((entries) => [...entries, entry]);

  function settle(gap: Gap, next: Profile, note: string, detail?: string[]) {
    setPinned(null);
    setAnswered((n) => n + 1);
    setFloor(stats.remaining);
    setSkipped((s) => [...s, gap.id]);
    say({ kind: 'result', id: `r-${gap.id}-${Date.now()}`, text: note, detail });
    if (next !== profile) onProfile(next, note);
  }

  function tap(replyId: string) {
    if (!current) return;
    const reply = replies.find((r) => r.id === replyId);
    if (!reply) return;

    say({ kind: 'answer', id: `a-${current.id}`, text: reply.label });

    // The half-answers open the box rather than committing anything.
    if (reply.followUp) {
      setPrompt(reply.followUp);
      box.current?.focus();
      return;
    }

    const { profile: next, summary } = applyQuickReply(profile, current, replyId);
    settle(current, next, summary || 'Noted.');
  }

  async function send() {
    const text = typed.trim();
    if (!current || !text || busy) return;

    say({ kind: 'answer', id: `a-${current.id}-${Date.now()}`, text });
    setTyped('');
    setPrompt(null);
    setBusy(true);
    setError(null);

    try {
      const reply = await provider.complete(
        {
          system: INTERVIEW_SYSTEM_PROMPT,
          user: buildAnswerPrompt(current, prompt ?? current.why, text, profile),
          jsonSchema: { name: 'drafted', schema: DRAFTED_BULLETS_JSON_SCHEMA },
        },
        config,
      );
      const drafted = draftedBulletsSchema.parse(reply.json);

      // The bullets are checked against what was actually said before any of
      // them reach the profile. Rewriting for strength is allowed; inventing a
      // number is caught here rather than trusted not to happen.
      const checked = verifyDraft(drafted.bullets, text, profile);

      // Everything lands through the ordinary merge, so duplicate detection,
      // fresh IDs and date corrections all come along unchanged.
      const bullets = current.kind === 'no-summary' ? [] : checked.kept.map((k) => k.bullet);
      // A question about projects can never write to an employer. Personal
      // work filed under a job says something untrue about who it was for, and
      // a fallback owner is exactly how that happened.
      const aboutProjects = current.kind === 'more-projects' || current.kind === 'thin-project';

      // An answer that named no role is placed by what the profile already
      // says, not by which job is newest.
      const guessed = aboutProjects ? null : bestOwner(profile, text);
      const fallback = aboutProjects
        ? ''
        : current.ownerId || guessed?.ownerId || profile.work[0]?.id || '';
      const ownerOf = (b: { ownerId: string }) => b.ownerId || fallback;

      const asBullets = (owner: string) =>
        bullets
          .filter((b) => ownerOf(b) === owner && b.text.trim())
          .map((b) => ({ id: ids.bullet(), text: b.text.trim(), tags: [], variants: [] }));

      // Projects: a thin-project answer lands on the project it was asked
      // about, and anything else the answer describes becomes its own entry.
      const projects = profile.projects.map((p) => ({
        ...p,
        bullets:
          current.kind === 'thin-project' && current.ownerId === p.id
            ? asBullets(p.id)
            : [],
      }));

      for (const drafted_p of drafted.newProjects) {
        if (!drafted_p.name.trim()) continue;
        projects.push({
          id: ids.project(),
          name: drafted_p.name.trim(),
          description: '',
          url: drafted_p.url.trim() || undefined,
          startDate: '',
          endDate: '',
          tags: [],
          bullets: drafted_p.bullets
            .filter((t) => t.trim())
            .map((t) => ({ id: ids.bullet(), text: t.trim(), tags: [], variants: [] })),
        });
      }

      const work = profile.work.map((w) => ({
        ...w,
        endDate: drafted.endedRole.ownerId === w.id && drafted.endedRole.endDate
          ? drafted.endedRole.endDate
          : w.endDate,
        bullets: aboutProjects ? [] : asBullets(w.id),
      }));

      if (drafted.newRole.name.trim()) {
        work.push({
          id: ids.work(),
          name: drafted.newRole.name,
          position: drafted.newRole.position,
          location: drafted.newRole.location,
          startDate: drafted.newRole.startDate,
          endDate: drafted.newRole.endDate,
          summary: '',
          tags: [],
          bullets: asBullets('new'),
        });
      }

      const incoming = profileSchema.parse({
        ...profile,
        id: ids.profile(),
        basics: { ...profile.basics, summary: drafted.summary.trim() || profile.basics.summary },
        work,
        projects,
      });

      const plan = planMerge(profile, incoming);
      const next = applyMerge(profile, plan, { sourceLabel: 'interview' });
      const counts = summarizeMerge(plan);

      const parts = [
        counts.newEntries && `${counts.newEntries} new ${aboutProjects ? 'project' : 'role'}${counts.newEntries > 1 ? 's' : ''}`,
        counts.newBullets && `${counts.newBullets} new bullet${counts.newBullets > 1 ? 's' : ''}`,
        counts.datesCorrected && `${counts.datesCorrected} date corrected`,
        drafted.summary.trim() && 'summary written',
      ].filter(Boolean) as string[];

      // One follow-up per question, never two: being asked twice about the
      // same thing is irritating in a way being asked once is not.
      const again = needsFollowUp(checked, text);
      const canAskAgain = !followedUp.includes(current.id);

      // No third condition. Requiring the model to have supplied a question
      // meant that when it returned neither bullets nor a follow-up — the exact
      // shape of a reply that needs one — the decision to ask was thrown away
      // and the interview moved on without a word.
      if (again.follow && canAskAgain) {
        setFollowedUp((ids) => [...ids, current.id]);
        // Hold this question open until the follow-up is answered.
        setPinned(current);
        // Whatever *was* writable still lands now, rather than waiting on the
        // rest of the answer.
        if (next !== profile) onProfile(next, 'partial');

        const question = followUpQuestion(current, drafted.followUp);

        say({
          kind: 'result',
          id: `f-${current.id}-${Date.now()}`,
          // Say what was kept as well as what was not. "Nothing was specific
          // enough" is wrong and discouraging when a bullet did land.
          text: parts.length ? `Added: ${parts.join(', ')}. One more —` : `One more —`,
          detail: [
            ...bullets.map((b) => b.text),
            ...checked.rejected.map((r) => `not used — ${r.bullet.text}`),
          ].filter((line) => line.trim()),
        });
        say({ kind: 'question', id: `q2-${current.id}`, gap: current, text: question });
        setPrompt(question);
        return;
      }

      settle(
        current,
        next,
        parts.length ? `Added: ${parts.join(', ')}.` : 'Nothing to add from that — no bullet earned.',
        [
          ...bullets.map((b) => b.text),
          ...checked.rejected.map((r) => `not used — ${r.bullet.text}`),
        ].filter((line) => line.trim()),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // The question stays open so the answer is not lost.
    } finally {
      setBusy(false);
    }
  }

  if (!current) {
    return (
      <div className="card-glass p-5">
        <h2 className="text-base font-semibold">Nothing left to ask</h2>
        <p className="mt-1 text-sm text-stone-600">
          {answered > 0
            ? `${answered} question${answered > 1 ? 's' : ''} answered. Everything the profile could tell us about is filled in.`
            : 'This profile has no gaps worth asking about.'}
        </p>
        <button className="btn-primary mt-4" onClick={onDone}>
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className="card-glass flex flex-col p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">A few questions</h2>
        <span className="font-mono text-xs text-stone-500">
          {stats.remaining} left{answered > 0 ? ` · ${answered} answered` : ''}
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-stone-200">
        <div
          className="h-full rounded-full bg-stone-700 transition-all duration-500"
          style={{ width: `${Math.round(stats.fraction * 100)}%` }}
        />
      </div>

      <div className="mt-4 flex max-h-[26rem] flex-col gap-3 overflow-y-auto pr-1">
        {log.map((entry) =>
          entry.kind === 'question' ? (
            <div key={entry.id} className="max-w-[85%]">
              <p className="rounded-lg rounded-bl-sm bg-stone-100 px-3 py-2 text-sm">
                {questionFor(entry.gap)}
              </p>
              <p className="mt-1 pl-1 text-xs text-stone-500">{entry.text}</p>
            </div>
          ) : entry.kind === 'answer' ? (
            <p
              key={entry.id}
              className="ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-stone-700 px-3 py-2 text-sm text-white"
            >
              {entry.text}
            </p>
          ) : (
            <div key={entry.id} className="max-w-[90%] rounded-md bg-emerald-50 px-3 py-2">
              <p className="text-sm text-emerald-900">{entry.text}</p>
              {entry.detail?.map((d, i) => (
                <p key={i} className="mt-1 text-xs text-emerald-800">
                  · {d}
                </p>
              ))}
            </div>
          ),
        )}
        {busy && <p className="text-sm text-stone-500">Reading that…</p>}
        <div ref={bottom} />
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </div>
      )}

      {!busy && replies.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {replies.map((r) => (
            <button
              key={r.id}
              className="btn-secondary text-sm"
              onClick={() => tap(r.id)}
              disabled={!ready && !r.immediate}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3">
        {prompt && <p className="mb-1 text-xs text-stone-500">{prompt}</p>}
        <textarea
          ref={box}
          className="field min-h-[4.5rem] text-sm"
          placeholder={prompt ?? 'Or answer in your own words…'}
          value={typed}
          disabled={busy}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <button className="btn-primary text-sm" onClick={() => void send()} disabled={busy || !typed.trim() || !ready}>
            Send
          </button>
          <button
            className="btn-secondary text-sm"
            onClick={() => {
              say({ kind: 'answer', id: `s-${current.id}`, text: 'Skip' });
              settle(current, profile, 'Skipped.');
              setPrompt(null);
            }}
            disabled={busy}
          >
            Skip
          </button>
          <span className="ml-auto text-xs text-stone-500">⌘↵ to send</span>
        </div>
        {!ready && (
          <p className="mt-2 text-xs text-stone-500">
            Answering in your own words needs an API key. The tap replies work without one.
          </p>
        )}
      </div>

      <button className="btn-secondary mt-4 self-start text-sm" onClick={onDone}>
        Done for now
      </button>
    </div>
  );
}

/** The question itself. `why` is shown separately, as the reason underneath. */
function questionFor(gap: Gap): string {
  switch (gap.kind) {
    case 'recent-work':
      return gap.id === 'recent:none'
        ? 'Where have you worked?'
        : 'Are you still in the same role, or have you moved since?';
    case 'unbacked-skill':
      return `Where have you used ${gap.subject}?`;
    case 'thin-role':
      return `What else did you do at ${gap.subject}?`;
    case 'undated-role':
      return `When did you work at ${gap.subject}?`;
    case 'missing-requirement':
      return `This posting asks for ${gap.subject}. Have you done it?`;
    case 'more-projects':
      return 'Any projects or published packages worth adding?';
    case 'thin-project':
      return `What is ${gap.subject}, and what did you build in it?`;
    case 'no-summary':
      return 'How would you describe what you do, in a sentence or two?';
  }
}
