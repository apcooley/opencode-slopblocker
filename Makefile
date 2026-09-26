.PHONY: check test typecheck

check: test typecheck

test:
	bun test

typecheck:
	bun run typecheck
