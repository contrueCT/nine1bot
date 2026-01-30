---
name: image-generation
description: Use this skill when generating images programmatically with Python. This includes creating charts, diagrams, mind maps, flowcharts, infographics, data visualizations, annotated images, posters, and any visual output that requires code-based rendering. Trigger when user asks to "generate an image", "create a diagram", "draw a chart", "make a mind map", "visualize data", or requests any PNG/JPG/SVG output created via code. Also use when matplotlib, PIL/Pillow, or similar graphics libraries are needed.
---

# Image Generation Guide

Generate images programmatically using Python. This guide covers matplotlib for diagrams/charts and PIL for image manipulation.

## Environment Setup

```bash
pip install matplotlib pillow numpy --break-system-packages
```

### Chinese Font Configuration (Critical)

Chinese text renders as boxes without proper fonts. Always configure before plotting:

```python
import matplotlib.pyplot as plt

# Check available CJK fonts
import matplotlib.font_manager as fm
cjk_fonts = [f.name for f in fm.fontManager.ttflist 
             if 'CJK' in f.name or 'Noto' in f.name or 'WenQuanYi' in f.name]
print(cjk_fonts)

# Configure (use first available)
plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'WenQuanYi Zen Hei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False  # Fix minus sign display
```

If no CJK fonts available, install: `apt-get install -y fonts-noto-cjk fonts-wqy-zenhei`

## Quick Start

### Basic Chart
```python
import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots(figsize=(10, 6), dpi=150)
x = np.linspace(0, 10, 100)
ax.plot(x, np.sin(x), label='sin(x)')
ax.plot(x, np.cos(x), label='cos(x)')
ax.set_xlabel('x')
ax.set_ylabel('y')
ax.legend()
ax.set_title('Trigonometric Functions')
plt.savefig('chart.png', bbox_inches='tight', facecolor='white')
plt.close()
```

### Basic Diagram (No Axes)
```python
fig, ax = plt.subplots(figsize=(12, 8), dpi=150)
ax.set_xlim(0, 12)
ax.set_ylim(0, 8)
ax.set_aspect('equal')
ax.axis('off')  # Hide axes for diagrams

# Draw shapes
from matplotlib.patches import FancyBboxPatch, Circle, Arrow
box = FancyBboxPatch((1, 3), 3, 2, boxstyle="round,pad=0.1", 
                      facecolor='#3498DB', edgecolor='white', linewidth=2)
ax.add_patch(box)
ax.text(2.5, 4, 'Node A', ha='center', va='center', color='white', fontsize=12)

plt.savefig('diagram.png', bbox_inches='tight', facecolor='white')
plt.close()
```

## Core Patterns

### 1. Mind Map / Tree Diagram

Use radial or hierarchical layout with FancyBboxPatch for nodes:

```python
def draw_node(ax, x, y, text, color, width=2.5, height=0.8, fontsize=10):
    """Draw a rounded rectangle node with centered text."""
    from matplotlib.patches import FancyBboxPatch
    box = FancyBboxPatch((x - width/2, y - height/2), width, height,
                         boxstyle="round,pad=0.05,rounding_size=0.2",
                         facecolor=color, edgecolor='white', linewidth=2)
    ax.add_patch(box)
    ax.text(x, y, text, ha='center', va='center', fontsize=fontsize, 
            color='white', weight='bold')

def draw_connection(ax, start, end, color='#555'):
    """Draw a line between two points."""
    ax.plot([start[0], end[0]], [start[1], end[1]], 
            color=color, linewidth=2, zorder=0)
```

See `scripts/mindmap_template.py` for complete example.

### 2. Flowchart

Use different shapes for different node types:

| Shape | Meaning | Code |
|-------|---------|------|
| Rectangle | Process | `FancyBboxPatch` with `boxstyle="round"` |
| Diamond | Decision | `RegularPolygon` with `numVertices=4, orientation=np.pi/4` |
| Parallelogram | Input/Output | Custom `Polygon` |
| Oval | Start/End | `Ellipse` |

Use `FancyArrowPatch` for arrows with `arrowstyle='->'`.

### 3. Data Visualization

```python
# Bar chart
ax.bar(categories, values, color=['#E74C3C', '#3498DB', '#2ECC71'])

# Pie chart
ax.pie(sizes, labels=labels, autopct='%1.1f%%', colors=colors)

# Heatmap
im = ax.imshow(data, cmap='viridis')
plt.colorbar(im)

# Scatter with size/color encoding
ax.scatter(x, y, s=sizes, c=colors, alpha=0.6)
```

### 4. Annotated Images (PIL + matplotlib)

```python
from PIL import Image
import matplotlib.pyplot as plt

# Load and display image
img = Image.open('photo.jpg')
fig, ax = plt.subplots()
ax.imshow(img)

# Add annotations
ax.annotate('Important!', xy=(100, 150), xytext=(200, 100),
            arrowprops=dict(arrowstyle='->', color='red'),
            fontsize=12, color='red')
ax.add_patch(plt.Rectangle((50, 50), 100, 80, fill=False, edgecolor='red', linewidth=2))

ax.axis('off')
plt.savefig('annotated.png', bbox_inches='tight')
```

## Color Palettes

Professional color schemes:

```python
# Modern flat colors
COLORS = {
    'red': '#E74C3C',
    'blue': '#3498DB', 
    'green': '#2ECC71',
    'orange': '#F39C12',
    'purple': '#9B59B6',
    'teal': '#1ABC9C',
    'dark': '#2C3E50',
    'gray': '#95A5A6'
}

# Categorical palette (up to 10 items)
CATEGORICAL = ['#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6',
               '#1ABC9C', '#E67E22', '#16A085', '#8E44AD', '#2980B9']

# Sequential palette (for gradients)
# Use matplotlib colormaps: 'viridis', 'plasma', 'Blues', 'Reds'
```

## Common Issues & Solutions

### Issue: Chinese characters show as boxes
**Solution**: Configure CJK fonts before any plotting (see Environment Setup)

### Issue: Image has extra whitespace
**Solution**: Use `bbox_inches='tight'` in `savefig()`

### Issue: Low resolution output
**Solution**: Increase `dpi` (150-300 for print quality)

### Issue: Transparent background needed
**Solution**: `savefig('out.png', transparent=True)`

### Issue: Elements overlap
**Solution**: Adjust `figsize`, use `plt.tight_layout()`, or manually position

### Issue: Subscript/superscript characters missing
**Solution**: Avoid Unicode subscripts (₀₁₂). Use LaTeX: `$H_2O$`, `$x^2$`

## Output Guidelines

1. Always use `dpi=150` minimum (300 for print)
2. Use `facecolor='white'` for consistent background
3. Call `plt.close()` after saving to free memory
4. Save to `/mnt/user-data/outputs/` for user access
5. Prefer PNG for diagrams, JPG for photos

## File Structure

```
scripts/
├── mindmap_template.py    # Mind map with radial layout
├── flowchart_template.py  # Flowchart with decision nodes
└── chart_templates.py     # Common chart types

references/
├── MATPLOTLIB_SHAPES.md   # All available shapes and patches
└── COLOR_REFERENCE.md     # Extended color palettes
```

## Next Steps

- For complex mind maps: See `scripts/mindmap_template.py`
- For flowcharts: See `scripts/flowchart_template.py`
- For shape reference: See `references/MATPLOTLIB_SHAPES.md`
- For extended colors: See `references/COLOR_REFERENCE.md`
