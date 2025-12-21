# Contributing to Trading AI Agent

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## 🚀 Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/yourusername/trading-ai-agent.git`
3. Create a branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Test your changes: `npm test`
6. Commit: `git commit -m 'Add some feature'`
7. Push: `git push origin feature/your-feature-name`
8. Open a Pull Request

## 📋 Development Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Build the project
npm run build

# Run tests
npm test

# Run linter
npm run lint

# Format code
npm run format
```

## 🎯 Code Style

- **TypeScript**: Use strict typing, avoid `any`
- **Formatting**: Use Prettier (config in `.prettierrc.json`)
- **Linting**: Follow ESLint rules (config in `.eslintrc.json`)
- **Naming**: 
  - Classes: `PascalCase`
  - Functions/Variables: `camelCase`
  - Constants: `UPPER_SNAKE_CASE`
- **Comments**: Use JSDoc for exported functions

## ✅ Testing

- Write tests for new features
- Maintain test coverage above 70%
- Run `npm test` before committing
- Add integration tests for new services

## 📝 Commit Messages

Follow the Conventional Commits specification:

```
feat: add support for new exchange
fix: resolve indicator calculation bug
docs: update README with examples
test: add tests for backtest module
refactor: simplify AI prompt generation
```

## 🔍 Pull Request Process

1. Update documentation if needed
2. Add tests for new functionality
3. Ensure all tests pass
4. Update CHANGELOG.md
5. Request review from maintainers

## 🐛 Bug Reports

When reporting bugs, include:

- Description of the issue
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, Node version, etc.)
- Relevant logs

## 💡 Feature Requests

For new features:

- Describe the feature clearly
- Explain use cases
- Provide examples if possible
- Discuss potential implementation

## 🔐 Security

Report security vulnerabilities privately to the maintainers.

## 📜 License

By contributing, you agree that your contributions will be licensed under the MIT License.
