# Security

jev-axi sends the state you give it (file contents, diffs, logs, stdin) to the
TypeSafe API. Do not point it at data you are not allowed to send to a third
party. The `guard` command is a screening aid, not a guarantee; treat its
verdicts as probabilities.

API keys are read from `TYPESAFE_API_KEY`, a `.env` in the working directory,
or the config file, and are never written to the usage ledger or cache.

To report a vulnerability, open a private security advisory on GitHub or email
the maintainer listed in `package.json`. Please do not file public issues for
security problems.
