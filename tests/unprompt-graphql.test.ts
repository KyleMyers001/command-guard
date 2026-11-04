import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {expectVerdicts} from './helpers/verdict.ts';

// EL-115 PR6: a read-only `gh api graphql` query no longer prompts. Anything
// that could mutate, read a local file, change host, or is not plainly a
// query keeps the verdict it has on main. Verdicts come from the shipped
// policy; nothing is executed.
test('read-only gh api graphql queries are allowed', async t => {
  await expectVerdicts(
    'ALLOW',
    [
      "gh api graphql -f query='{ viewer { login } }'",
      "gh api graphql -F query='{ viewer { login } }'",
      "gh api graphql --raw-field query='{ viewer { login } }'",
      "gh api graphql -f query='query { viewer { login } }'",
      'gh api graphql -f query=\'query($owner:String!){repository(owner:$owner,name:"x"){id}}\' -f owner=foo',
      "gh api graphql -F owner='{owner}' -F name={repo} -f query='query { repository { id } }'",
      "gh api graphql -F count=5 -f query='query { viewer { login } }'",
      "gh api graphql --paginate -f query='{ viewer { login } }' --jq '.data.viewer.login'",
      "gh api graphql -f query='{ viewer { login } }' -q .data --cache 1h --slurp",
      "gh api graphql -f query='query {\n  viewer { login }\n}'",
      "gh -R o/r api graphql -f query='{ viewer { login } }'",
      "cd repo && gh api graphql -f query='{ viewer { login } }'",
    ],
    fixture(t),
  );
});

test('graphql mutations and other forms keep main verdicts', async t => {
  await expectVerdicts(
    'ASK',
    [
      'gh api graphql -f query=\'mutation { addStar(input:{starrableId:"x"}){clientMutationId} }\'',
      "gh api graphql -f query='MUTATION{x}'",
      "gh api graphql -f query='Mutation M { x }'",
      "gh api graphql -f query='query { a } mutation { b }'",
      "gh api graphql -f query='{ viewer { login } }' -f note=mutation",
      "gh api graphql -f query='{ viewer { login } }' && echo mutation",
      "gh api graphql -f query='mut'ation'{x}'",
      "gh api graphql -f query=$'mutation {x}'",
      'gh api graphql -f query=mutation',
      'gh api graphql -F query=@q.graphql',
      'gh api graphql -f query=@q.graphql',
      "gh api graphql -f query='@q.graphql'",
      "gh api graphql -F 'query=@q.graphql'",
      "gh api graphql -F body=@secret.txt -f query='{ viewer { login } }'",
      "gh api graphql -f query='{ viewer { login } }' -f body=@x",
      "gh api graphql -f query='{ viewer { login } }' -F 'body=@x'",
      'gh api graphql --input q.json',
      'gh api graphql --input -',
      "gh api graphql -f query='{ viewer { login } }' --input q.json",
      "gh api graphql -f query='{ viewer { login } }' --hostname evil.test",
      "gh api graphql -f query='{ viewer { login } }' -H 'X-Y: z'",
      "gh api graphql -f query='{ viewer { login } }' -X POST",
      "gh api graphql -f query='{ viewer { login } }' --method=PUT",
      "gh api graphql -f query='{ viewer { login } }' -XPATCH",
      "gh api graphql -f query='{ viewer { login } }' --preview x",
      "gh api graphql -f query='{ viewer { login } }' --include",
      'gh api graphql -f query="{ viewer { login } }"',
      'gh api graphql -f query=$Q',
      'gh api graphql -f query="$Q"',
      'gh api graphql -f query=$(cat q.graphql)',
      "gh api graphql -f query='{ x }' -f owner=$USER",
      "gh api graphql -f query='{ viewer { login } }'; gh api -X POST repos/o/r/issues -f title=x",
      "gh api graphql -f query='{ viewer { login } }'; gh api repos/o/r/issues -f title=x",
      "gh api graphqlx -f query='{ x }'",
      "gh api graphql/extra -f query='{ x }'",
      'gh api repos/o/r/issues -f title=x',
      'gh api repos/o/r/pulls/3 -F draft=true',
      "gh api -f query='{ viewer { login } }' graphql",
      "gh api graphql -f query='{ x }' -f 'a=b;c'",
      "gh api graphql -f query='{ viewer { login } }'; gh pr merge 3",
    ],
    fixture(t),
  );
  await expectVerdicts(
    'DENY',
    [
      "gh api graphql -X DELETE -f query='{ viewer { login } }'",
      "gh api graphql -f query='{ viewer { login } }' --method DELETE",
      'gh auth token',
    ],
    fixture(t),
  );
});

test('repeated graphql query fields stay linear', async t => {
  const cwd = fixture(t);
  const field = "-f query='{viewer{login}}' ";
  const start = Date.now();
  await expectVerdicts(
    'ASK',
    [`gh api graphql ${field.repeat(60)}--input x`],
    cwd,
  );
  if (Date.now() - start > 4000)
    throw new Error('graphql matching is not linear');
});

test('graphql queries with gh placeholders keep asking', async t => {
  await expectVerdicts(
    'ASK',
    [
      'gh api graphql -F query=\'{repo} { deleteRef(input: {refId: "ID"}) {__typename}}\'',
      'gh api graphql -f query=\'{repository(owner:"{owner}",name:"x"){id}}\'',
      "gh api graphql -F 'query={branch}'",
    ],
    fixture(t),
  );
});
