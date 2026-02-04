---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

## Mobile-Friendly Design

Every app MUST be fully usable on both desktop and mobile devices. Design for desktop but ensure everything works perfectly on mobile too:

- **Touch Targets**: All interactive elements (buttons, links, inputs) must be at least 44×44px. Add generous padding to tap targets — fingers are imprecise.
- **Viewport & Scaling**: Never use fixed pixel widths on containers. Use `max-w-screen-*`, percentages, `vw`/`vh` (with `dvh` for mobile viewport), or fluid Tailwind utilities. Ensure no horizontal scrolling on any screen size.
- **Responsive Typography**: Use Tailwind responsive prefixes (`text-sm md:text-base lg:text-lg`) or `clamp()` for fluid type scaling. Headlines that look great on desktop must not overflow or be unreadably large on a 375px screen.
- **Layout Adaptation**: Use single-column layouts on mobile. Multi-column grids (`grid-cols-2`, `grid-cols-3`) must collapse to fewer columns on small screens (e.g. `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`). Sidebars should become drawers or collapse behind a toggle on mobile.
- **Spacing & Overflow**: Reduce padding/margins on mobile (`p-4 md:p-8 lg:p-12`). Ensure no content is clipped or hidden behind fixed elements. Test that scroll containers work properly with touch.
- **Navigation**: Use mobile-friendly nav patterns — bottom sheets, hamburger menus, or tab bars — rather than wide horizontal navbars that break on small screens.
- **Images & Media**: Use `max-w-full` and `object-cover`/`object-contain` so media scales without breaking layout. Avoid fixed-dimension images.
- **Forms & Inputs**: Use appropriate input types (`type="email"`, `type="tel"`, `inputmode="numeric"`) for better mobile keyboards. Make form fields full-width on mobile. Ensure sufficient spacing between form elements for easy tapping.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.
