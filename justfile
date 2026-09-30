# Default recipe
default: build

# Install dependencies
install-deps:
    bun install

# Build compiled binary
build: install-deps
    bun build main.ts --compile --outfile tik

# Run the CLI with optional args
run *args:
    bun run main.ts {{args}}

# Type check
check:
    bun run tsc --noEmit

# Clean build artifacts
clean:
    rm -rf tik node_modules

# Install to ~/.local/bin
install: build
    cp tik ~/.local/bin/

# Show binary size
size: build
    ls -lh tik

# Clear credential cache
clear-cache:
    rm -f /tmp/tik-creds-$(id -u)
