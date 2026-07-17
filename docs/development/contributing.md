# Contributing Guide

This document will guide you through setting up the ChronoFrame development environment, including environment requirements, dependency installation, configuration settings, and development tools.

## Environment Requirements

### Required Software

- **Node.js**: 22.12+
- **pnpm**: 10.0+ (preferred package manager)
- **Git**: Latest version
- **Cloudflare account**: Optional for local mocks; required for remote integration testing

## Clone and Install

### 1. Clone Repository

```bash
# Using HTTPS
git clone https://github.com/HoshinoSuzumi/chronoframe.git

# Or using SSH
git clone git@github.com:HoshinoSuzumi/chronoframe.git

# Enter project directory
cd chronoframe

# Set upstream remote repository
git remote add upstream https://github.com/HoshinoSuzumi/chronoframe.git
```

### 2. Install Dependencies

```bash
# Install pnpm (if not already installed)
npm install -g pnpm

# Install project dependencies
pnpm install
```

### 3. Configure Environment Variables

```bash
# Copy public configuration as needed
cp .env.example .env

# Keep local runtime secrets out of Git. Start from `.dev.vars.example` and
# provide independent 32+ character values for NUXT_SESSION_PASSWORD and
# CFRAME_BOOTSTRAP_TOKEN. Copy Cloudflare's Stream webhook secret when testing
# signed callbacks locally.
cp .dev.vars.example .dev.vars

# Edit environment variables
nano .env  # Or use your preferred editor
```

#### Minimal Development Configuration

```bash
# === Authentication Settings ===
NUXT_OAUTH_GITHUB_CLIENT_ID=your-dev-github-client-id
NUXT_OAUTH_GITHUB_CLIENT_SECRET=your-dev-github-client-secret
# NUXT_SESSION_PASSWORD, CFRAME_BOOTSTRAP_TOKEN, and CFRAME_STREAM_WEBHOOK_SECRET belong in .dev.vars, not this public file.

# === Map Services (optional) ===
NUXT_PUBLIC_MAPBOX_ACCESS_TOKEN=pk.your-development-token
NUXT_MAPBOX_ACCESS_TOKEN=sk.your-development-token

# === Enable Debug Info ===
VITE_SHOW_DEBUG_INFO=true
```

## Project Architecture

### Directory Structure

```
chronoframe/
├── app/                    # Nuxt 4 application directory
│   ├── components/         # Vue components
│   │   ├── ui/            # Common UI components
│   │   ├── photo/         # Photo-related components
│   │   ├── masonry/       # Masonry layout components
│   │   └── ...
│   ├── pages/             # Route pages
│   ├── composables/       # Vue composables
│   ├── stores/            # Pinia state management
│   ├── layouts/           # Layout templates
│   ├── plugins/           # Nuxt plugins
│   └── utils/             # Utility functions
├── packages/
│   └── webgl-image/       # WebGL image viewer package
│       ├── src/
│       │   ├── core/      # Core engine
│       │   ├── components/ # Vue components
│       │   └── types/     # Type definitions
│       └── package.json
├── server/                # Nitro server-side
│   ├── api/              # API routes
│   │   ├── photos/       # Photo management API
│   │   ├── auth/         # Authentication API
│   │   └── system/       # System API
│   ├── database/         # Database related
│   │   ├── schema.ts     # Database schema
│   │   └── migrations/   # Migration files
│   ├── services/         # Business logic services
│   │   ├── storage/      # Storage services
│   │   ├── image/        # Image processing
│   │   ├── location/     # Geolocation
│   │   └── pipeline-queue/ # Processing queue
│   ├── tasks/            # Background tasks
│   └── utils/            # Server-side utilities
├── shared/               # Shared code between frontend and backend
│   ├── types/           # TypeScript type definitions
│   └── utils/           # Shared utilities
├── docs/                # Project documentation
├── scripts/             # Build and deployment scripts
└── Configuration files...
```

### Technology Stack

#### Frontend Technologies

- **Nuxt 4**: Vue.js full-stack framework
- **TypeScript**: Type-safe JavaScript
- **TailwindCSS**: Utility-first CSS framework

#### Backend Technologies

- **Cloudflare Workers / Nitro**: Edge server runtime
- **D1**: SQLite-compatible serverless database
- **Drizzle ORM**: Type-safe ORM
- **Cloudflare Images**: Hosted image storage and transformations
- **Cloudflare Stream**: Direct video upload, processing, and HLS delivery
- **R2**: Other non-image, non-video object storage

## Development Workflow

### Start Development Server

```bash
# Generate bindings, initialize local D1, and start Wrangler
pnpm cf:typegen
pnpm d1:migrate:local
pnpm dev:worker
```

### Database Operations

```bash
# Generate migration files
pnpm d1:generate

# Execute local database migrations
pnpm d1:migrate:local
```

### Build Project

```bash
# Build WebGL dependency package
pnpm build:deps

# Build complete Worker project
pnpm build:worker

# Preview in Wrangler's local runtime
pnpm dev:worker
```

## Testing Environment

### Local Cloudflare Bindings

`wrangler dev` supplies local D1, R2, and Hosted Images binding implementations. Local data is isolated from production. Apply migrations with `pnpm d1:migrate:local` before starting the app. Validate Stream Direct Creator Upload and HLS playback against a deployed, account-backed preview; no Stream API token belongs in `.dev.vars`.

### GitHub OAuth App

1. Visit GitHub Settings > Developer settings > OAuth Apps
2. Create new OAuth app
3. Set callback URL: `http://localhost:3000/api/auth/github`
4. Put the Client ID in local configuration and the Client Secret in `.dev.vars`

### Mapbox Development Tokens

1. Register [Mapbox account](https://account.mapbox.com/)
2. Create development access tokens
3. Set URL restriction: `http://localhost:3000`
4. Add tokens to `.env` file

## Code Standards

### TypeScript Standards

```typescript
// ✅ Good practice
interface PhotoMetadata {
  id: string
  title?: string
  width: number
  height: number
  createdAt: Date
}

// ❌ Avoid using any
const processPhoto = (photo: any) => { ... }

// ✅ Use specific types
const processPhoto = (photo: PhotoMetadata) => { ... }
```

### Vue Component Standards

```vue
<!-- ✅ Recommended component structure -->
<script setup lang="ts">
// Imports
import { ref, computed } from 'vue'
import type { Photo } from '~/types'

// Props and Emits
interface Props {
  photos: Photo[]
  loading?: boolean
}

interface Emits {
  select: [photo: Photo]
  delete: [photoId: string]
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
})

const emit = defineEmits<Emits>()

// Reactive data
const selectedPhoto = ref<Photo | null>(null)

// Computed properties
const photoCount = computed(() => props.photos.length)

// Methods
const handlePhotoClick = (photo: Photo) => {
  selectedPhoto.value = photo
  emit('select', photo)
}
</script>

<template>
  <div class="photo-grid">
    <!-- Template content -->
  </div>
</template>

<style scoped>
/* Component styles */
</style>
```

### Database Calls

When using database operations in `server`, use `useDB()` to get the Drizzle instance. This composable is globally auto-imported on the server side:

```typescript
const db = useDB()

const photos = await db.select().from(photosTable)
```

### Commit Message Standards

Use [Conventional Commits](https://www.conventionalcommits.org/) standard:

```
feat: add photo batch delete functionality
fix: fix WebGL viewer compatibility issue in Safari
docs: update deployment documentation
style: unify code formatting
refactor: refactor storage service interface
test: add unit tests for photo upload
chore: update dependency versions
```

## Contribution Guidelines

### Development Process

1. **Fork Project**: Fork the project on GitHub
2. **Create Branch**: `git checkout -b feature/new-feature`
3. **Develop Feature**: Write code and tests
4. **Commit Changes**: Use standard commit messages
5. **Push Branch**: `git push origin feature/new-feature`
6. **Create PR**: Create Pull Request on GitHub

### Pull Request Checklist

Before submitting PR, ensure:

- Code passes all tests
- Follows code standards
- Updates relevant documentation
- Adds appropriate test cases
- PR description is clear with change explanations

## Contribution Opportunities

### Beginner-friendly Tasks

Look for Issues labeled with:

- `good first issue`: Tasks suitable for beginners
- `help wanted`: Tasks needing community help
- `documentation`: Documentation-related improvements

## Useful Resources

### Official Documentation

- [Nuxt 4 Documentation](https://nuxt.com/)
- [Vue 3 Documentation](https://vuejs.org/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [TailwindCSS Documentation](https://tailwindcss.com/)

### Community Resources

- [GitHub Issues](https://github.com/HoshinoSuzumi/chronoframe/issues)
- [GitHub Discussions](https://github.com/HoshinoSuzumi/chronoframe/discussions)
