# Sample profile and posting

A fictional master profile, a job posting it partly answers, and a tailoring
plan written for that pair. Together they show a full tailor-and-export run
without typing in your own data, and give the CLI and the Claude Code plugin
something to be tested against by hand.

| File | What it is |
| --- | --- |
| `profile.json` | Avery Lindqvist, a made-up full-stack engineer: three roles, three projects, four skill groups, a certificate. Matches `sartor schema profile`. |
| `posting.txt` | A senior product engineer posting. It asks for TypeScript, React, Node.js, PostgreSQL, accessibility and a published React library, all of which the profile has. It also asks for GraphQL, Kubernetes and Rust, which it does not. |
| `plan.json` | The plan an agent would write from `sartor tailor prompt`: which bullets to keep, in what order, a rewritten summary, and the gaps recorded in `notes`. Matches `sartor schema plan`. |

The gaps are the point. The posting wants GraphQL and Kubernetes; the profile
has neither, and a correct run leaves that visible rather than filling it in.
`src/cli/examples.test.ts` replays this plan on every `npm test`, so the sample
cannot drift away from the schemas.

## Running it

No API key is needed. The plan is already written, so the only step that would
call a model is replaced by reading `plan.json`.

From a clone, build the CLI and put it on your `PATH`:

```sh
npm install
npm run build:lib
npm link
```

If you would rather not link, replace `sartor` below with `node ../dist/cli.js`.

Then, from this directory:

```sh
cd examples

# 1. The prompt an agent would answer. With no model in the loop, this is just
#    something to read: the instructions, the profile and posting, and the plan
#    schema. --out writes it to a file rather than the terminal.
sartor tailor prompt --profile profile.json --posting posting.txt --pages 1 --out tailor-prompt.json

# 2. Apply the plan that was written for this posting. Anything that does not
#    point at the profile is dropped, the page is fitted using the renderer's
#    own measurements, and every generated line is checked against the profile.
sartor tailor apply --profile profile.json --posting posting.txt --plan plan.json --pages 1 --out run.json

# 3. Every change, numbered. Reject one to restore the profile's own wording.
sartor review run.json
sartor review run.json --reject 1

# 4. What the page shows, and which of the posting's terms it covers.
sartor check run.json

# 5. The resume. txt and docx work the same way.
sartor render run.json --format pdf --out resume.pdf
```

`tailor apply` prints a page estimate and how many bullets each entry kept;
`review` lists every bullet the fit had to cut to reach one page, each with its
reason. `check` lists GraphQL and Kubernetes under "not in the profile at all":
the posting requires both, the profile has neither, and nothing was invented to
cover the gap.

Everything these commands write (`tailor-prompt.json`, `run.json`,
`resume.pdf` and so on) is ignored by git, so running the walkthrough leaves
the sample files alone.

## Seeing the guard refuse

Edit the summary in `plan.json` to claim something the profile does not have,
for example "runs services on Kubernetes", and apply it again. `tailor apply`
reports one blocking change, and `render` exits with code 5 until that change
is rejected:

```sh
sartor review run.json            # the summary change is marked "not in profile: Kubernetes"
sartor review run.json --reject 1
sartor render run.json --format pdf --out resume.pdf
```

## The web app

These files are for the CLI and the plugin. Loading the sample into the web
app's UI is a separate feature.
