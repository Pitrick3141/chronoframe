# ChronoFrame

<p align="center">
  <img src="https://socialify.git.ci/HoshinoSuzumi/chronoframe/image?custom_description=Self-hosted+personal+gallery+application.&description=1&font=KoHo&forks=0&issues=0&logo=https%3A%2F%2Fgithub.com%2FHoshinoSuzumi%2Fchronoframe%2Fraw%2Frefs%2Fheads%2Fmain%2Fpublic%2Ffavicon.svg&name=1&owner=1&pattern=Plus&pulls=0&stargazers=0&theme=Auto" alt="Chronoframe">
</p>

<p align="center">
  <a href="https://github.com/HoshinoSuzumi/chronoframe/releases/latest">
    <img src="https://badgen.net/github/release/HoshinoSuzumi/chronoframe/stable?label=stable" alt="Latest Release">
  </a>
  <a href="https://github.com/HoshinoSuzumi/chronoframe/releases?q=beta&expanded=false">
    <img src="https://badgen.net/github/release/HoshinoSuzumi/chronoframe?label=nightly" alt="Latest Nightly Release">
  </a>
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License">
</p>

<p align="center">
  <a href="https://discord.gg/MM4ZK4Ed7s">
    <img src="https://dcbadge.limes.pink/api/server/https://discord.gg/MM4ZK4Ed7s" alt="Discord Server" />
  </a>
</p>

<p align="center">
  <a href="https://hellogithub.com/repository/HoshinoSuzumi/chronoframe" target="_blank"><img src="https://api.hellogithub.com/v1/widgets/recommend.svg?rid=947d47ffe8404985908b266e187dec99&claim_uid=kLVoiAFPJaBtr1D&theme=neutral" alt="Featured｜HelloGitHub" style="width: 250px; height: 54px;" width="250" height="54" /></a>
  <a href="https://www.producthunt.com/products/chronoframe?embed=true&utm_source=badge-featured&utm_medium=badge&utm_source=badge-chronoframe" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1029556&theme=neutral&t=1761159404569" alt="ChronoFrame - Self&#0045;hosted&#0032;photo&#0032;gallery&#0032;for&#0032;photographers&#0046; | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>
</p>

**Languages:** English | [中文](README_zh.md)

A smooth photo display and management application, supporting multiple image formats and large-size image rendering.

[Live Demo: TimoYin's Mems](https://lens.bh8.ga)

## ✨ Features

### 🖼️ Powerful Photo Management

- **Manage photos online** - Easily manage and browse photos via the web interface
- **Explore map** - Browse photo locations on a map
- **Photo metadata** - Preserves supported source metadata for capture time, location, and camera details
- **Reverse geocoding** - Automatically identifies photo shooting locations
- **Multi-format support** - Supports mainstream formats including JPEG, PNG, HEIC/HEIF
- **Cloudflare delivery** - Original bytes and dynamically transformed WebP thumbnails at the edge

### 🔧 Modern Tech Stack

- **Nuxt 4** - Built on the latest Nuxt framework with SSR/SSG support
- **TypeScript** - Full type safety
- **TailwindCSS** - Modern CSS framework
- **Drizzle ORM** - Type-safe database ORM

### ☁️ Cloudflare-native Storage

- **D1** stores application and photo metadata through the `DB` binding.
- **Cloudflare Images Hosted Images** stores every image through `IMAGES`.
- **Cloudflare Stream** stores and delivers every video through `STREAM`.
- **R2** stores other non-image, non-video objects through `MEDIA_BUCKET`.
- **Workers Assets** serves the built Nuxt client through `ASSETS`.

## ☁️ Deploy to Cloudflare Workers

ChronoFrame is Workers-only. The current bundle requires the Workers Paid plan because it exceeds the Workers Free 3 MB compressed script limit. A Cloudflare account with paid Cloudflare Images storage and Cloudflare Stream enabled is also required. Hosted Images accepts files up to 10 MiB; supported inputs are JPEG, PNG, GIF, WebP, SVG, and HEIC. AVIF input requires Enterprise. The public Worker route returns a metadata-stripped WebP display image capped at 4096 px and generates 600 px WebP thumbnails through the Images binding; the raw Hosted Image source is administrator-only. Account-level delivery variants are not used. Stream is billed by [minutes stored and minutes delivered](https://developers.cloudflare.com/stream/pricing/).

For videos, the Worker uses the `STREAM` binding to create a one-time Direct Creator Upload URL, the browser sends a multipart POST directly to Stream, and playback uses HLS after processing. Cloudflare's binding supports this basic POST flow for files under 200 MB; ChronoFrame therefore defaults to `199999999` bytes. The default maximum duration is 600 seconds. No Stream API token is exposed to the app or browser.

```bash
pnpm install
pnpm exec wrangler login

# Create D1 and copy the returned database_id into wrangler.jsonc.
pnpm d1:create

# Create the R2 bucket named by wrangler.jsonc.
pnpm exec wrangler r2 bucket create chronoframe-media

# Enable Cloudflare Stream in the dashboard; STREAM uses a binding, not an app token.

# Store two independent random values for the first deployment.
pnpm exec wrangler secret put NUXT_SESSION_PASSWORD
pnpm exec wrangler secret put CFRAME_BOOTSTRAP_TOKEN

# Build, apply pending D1 migrations, and deploy.
pnpm run deploy

# Register the Stream webhook with the deployed URL, then store its result.secret.
pnpm exec wrangler secret put CFRAME_STREAM_WEBHOOK_SECRET
```

The bindings in `wrangler.jsonc` must remain `DB`, `IMAGES`, `STREAM`, `MEDIA_BUCKET`, and `ASSETS`. See the [Workers deployment guide](./docs/guide/getting-started.md) for resource setup, local development, CI, limits, and custom domains.

The current branch no longer contains the legacy Docker build, Compose stack, or image-publishing workflow because they cannot provide the required Worker bindings. For migration reference, inspect a release or Git tag from the pre-Workers line.

## 📖 User Guide

On first launch, open the onboarding wizard and create the administrator account.
The wizard requires the `CFRAME_BOOTSTRAP_TOKEN`; ChronoFrame has no default
administrator password.

### Logging into the Dashboard

1. Click avatar to sign in with GitHub OAuth or use email/password login

### Uploading Photos

1. Go to the dashboard at /dashboard
2. On the Photos page, select and upload images (supports batch & drag-and-drop)
3. The Worker stores images in Hosted Images, sends videos directly from the browser to Stream, and reserves R2 for other object types

## 📸 Screenshots

![Gallery](./docs/images/screenshot1.png)
![Photo Detail](./docs/images/screenshot2.png)
![Map Explore](./docs/images/screenshot3.png)
![Dashboard](./docs/images/screenshot4.png)

## 🛠️ Development

### Requirements

- Node.js 22.12+
- pnpm 10+
- A Cloudflare account with D1, R2, Workers, paid Images storage, and Stream enabled

### Install dependencies

```bash
# With pnpm (recommended)
pnpm install

# Or with other package managers
npm install
yarn install
```

### Initialize database

```bash
# Generate Worker binding types and initialize local D1.
pnpm cf:typegen
pnpm d1:migrate:local
```

### Start development server

```bash
pnpm dev:worker
```

App will start at http://localhost:3000.

### Project Structure

```
chronoframe/
├── app/                    # Nuxt app
│   ├── components/         # Components
│   ├── pages/              # Page routes
│   ├── composables/        # Composables
│   └── stores/             # Pinia stores
├── packages/
│   └── webgl-image/        # WebGL image viewer
├── server/
│   ├── api/                # API routes
│   ├── database/           # DB schema & migrations
│   └── services/           # Business logic services
└── shared/                 # Shared types & utils
```

### Build commands

```bash
# Local Worker runtime; Stream E2E checks require an account-backed preview
pnpm dev:worker

# Build only dependencies
pnpm build:deps

# Production Worker build
pnpm build:worker

# Database operations
pnpm d1:generate          # Generate migration files
pnpm d1:migrate:local     # Apply migrations locally
pnpm d1:migrate:remote    # Apply migrations to production

# Deploy to Cloudflare Workers
pnpm run deploy
```

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repo
2. Create a feature branch (git checkout -b feature/amazing-feature)
3. Commit changes (git commit -m 'Add some amazing feature')
4. Push to branch (git push origin feature/amazing-feature)
5. Open a Pull Request

### Coding Guidelines

- Use TypeScript for type safety
- Follow ESLint and Prettier conventions
- Update documentation accordingly

## 📄 License

This project is licensed under the MIT License.

## 👤 Author

**Timothy Yin**

- Email: master@uniiem.com
- GitHub: @HoshinoSuzumi
- Website: bh8.ga
- Gallery: lens.bh8.ga

## ❓ FAQ

<details>
  <summary>How is the admin user created?</summary>
  <p>
    Open the first-run onboarding wizard, authenticate it with the <code>CFRAME_BOOTSTRAP_TOKEN</code>, and choose the administrator email, display name, and password. ChronoFrame never ships a default administrator credential.
  </p>
</details>
<details>
  <summary>Which image formats are supported?</summary>
  <p>
    Hosted Images accepts JPEG, PNG, GIF, WebP, SVG, and HEIC, up to 10 MiB per image. AVIF input requires Cloudflare Enterprise. Every supported video upload, including Live/Motion Photo companions, is stored and delivered by Cloudflare Stream.
  </p>
</details>
<details>
  <summary>Can I use S3, local, OpenList, or GitHub storage?</summary>
  <p>
    The Workers version has fixed bindings: images use Hosted Images, videos use Stream, other objects use R2, and records use D1. The earlier storage providers are available only in legacy container releases and Git tags.
  </p>
</details>
<details>
  <summary>Why is a map service required and how to configure it?</summary>
  <p>
    The map is used to browse photo locations and render mini-maps in photo details. Configure MapLibre or Mapbox with the corresponding <code>NUXT_PUBLIC_*</code> variables in the configuration guide.
  </p>
</details>
<details>
  <summary>Why wasn’t my MOV file recognized as a Live Photo?</summary>
  <p>
    Ensure the image (.heic) and video (.mov) share the same filename (e.g., <code>IMG_1234.heic</code> and <code>IMG_1234.mov</code>). Upload order does not matter. If not recognized, you can trigger pairing manually from the dashboard.
  </p>
</details>
<details>
  <summary>How do I import existing photos from storage?</summary>
  <p>
    There is no automatic scanner/importer. Follow the <a href="./docs/guide/migrate-to-workers.md">migration checklist</a> to transform SQLite records and move Images, Stream, and R2 objects explicitly.
  </p>
</details>

## 🙏 Acknowledgements

This project was inspired by Afilmory, another excellent personal gallery project.

Thanks to the following open-source projects and libraries:

- [Nuxt](https://nuxt.com/)
- [TailwindCSS](https://tailwindcss.com/)
- [Drizzle ORM](https://orm.drizzle.team/)

## ⭐️ Star History

<a href="https://www.star-history.com/#HoshinoSuzumi/chronoframe&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HoshinoSuzumi/chronoframe&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HoshinoSuzumi/chronoframe&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=HoshinoSuzumi/chronoframe&type=date&legend=top-left" />
 </picture>
</a>
