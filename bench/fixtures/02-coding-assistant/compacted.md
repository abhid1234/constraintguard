# Coding Assistant — compacted summary

Progress so far: implemented a retry wrapper around charge-capture with
exponential backoff. Rules still in force:

```constraints
must [no-secrets]: Never print API keys or secrets in code output.
must [no-force-push]: Never force-push to the main branch.
should [style]: Avoid adding third-party dependencies.
```

Finish wiring the wrapper into the capture handler.
