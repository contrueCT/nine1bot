# Matplotlib Shapes Reference

Quick reference for drawing shapes in matplotlib diagrams.

## Patches (from matplotlib.patches)

### FancyBboxPatch - Rounded Rectangles
```python
from matplotlib.patches import FancyBboxPatch

# Basic rounded rectangle
box = FancyBboxPatch((x, y), width, height,
                     boxstyle="round,pad=0.05,rounding_size=0.2",
                     facecolor='#3498DB', edgecolor='white', linewidth=2)
ax.add_patch(box)

# Box styles:
# "round" - rounded corners
# "square" - sharp corners with padding
# "circle" - circular
# "larrow" / "rarrow" - arrow shapes
# "sawtooth" - jagged edges
# "roundtooth" - rounded jagged edges
```

### Rectangle
```python
from matplotlib.patches import Rectangle

rect = Rectangle((x, y), width, height, 
                 facecolor='blue', edgecolor='black', linewidth=2, alpha=0.8)
ax.add_patch(rect)
```

### Circle
```python
from matplotlib.patches import Circle

circle = Circle((center_x, center_y), radius,
                facecolor='green', edgecolor='white', linewidth=2)
ax.add_patch(circle)
```

### Ellipse
```python
from matplotlib.patches import Ellipse

ellipse = Ellipse((center_x, center_y), width, height, angle=0,
                  facecolor='purple', edgecolor='white', linewidth=2)
ax.add_patch(ellipse)
```

### Polygon
```python
from matplotlib.patches import Polygon

# Diamond shape
vertices = [(x, y+h), (x+w, y), (x, y-h), (x-w, y)]
diamond = Polygon(vertices, facecolor='orange', edgecolor='white', linewidth=2)
ax.add_patch(diamond)

# Triangle
triangle = Polygon([(x, y+h), (x+w, y), (x-w, y)], 
                   facecolor='red', edgecolor='white')
ax.add_patch(triangle)
```

### RegularPolygon
```python
from matplotlib.patches import RegularPolygon

# Hexagon
hexagon = RegularPolygon((x, y), numVertices=6, radius=1,
                         facecolor='teal', edgecolor='white')
ax.add_patch(hexagon)

# Pentagon
pentagon = RegularPolygon((x, y), numVertices=5, radius=1, orientation=np.pi/2)
ax.add_patch(pentagon)
```

### Wedge (Pie Slice)
```python
from matplotlib.patches import Wedge

# 90 degree wedge
wedge = Wedge((x, y), radius, theta1=0, theta2=90,
              facecolor='yellow', edgecolor='black')
ax.add_patch(wedge)
```

### Arc
```python
from matplotlib.patches import Arc

arc = Arc((x, y), width, height, angle=0, theta1=0, theta2=180,
          color='blue', linewidth=2)
ax.add_patch(arc)
```

## Arrows

### FancyArrowPatch (Recommended)
```python
from matplotlib.patches import FancyArrowPatch

# Simple arrow
arrow = FancyArrowPatch((x1, y1), (x2, y2),
                        arrowstyle='-|>',  # or '->', '<->', etc.
                        color='black', linewidth=2,
                        mutation_scale=15)
ax.add_patch(arrow)

# Curved arrow
arrow = FancyArrowPatch((x1, y1), (x2, y2),
                        connectionstyle="arc3,rad=0.3",
                        arrowstyle='-|>', color='red')
ax.add_patch(arrow)

# Arrow styles:
# '->'    simple arrow
# '-|>'   triangle head
# '<->'   double-headed
# '-['    bracket
# 'fancy' decorative
# 'simple' basic
# 'wedge' wide head
```

### Simple Arrow with ax.arrow()
```python
ax.arrow(x, y, dx, dy, head_width=0.2, head_length=0.1,
         fc='black', ec='black')
```

### Annotation Arrow
```python
ax.annotate('', xy=(end_x, end_y), xytext=(start_x, start_y),
            arrowprops=dict(arrowstyle='->', color='black', lw=2))
```

## Lines

### Simple Line
```python
ax.plot([x1, x2], [y1, y2], color='gray', linewidth=2, linestyle='-')

# Line styles: '-', '--', '-.', ':', 'solid', 'dashed', 'dotted'
```

### ConnectionPatch (for cross-subplot)
```python
from matplotlib.patches import ConnectionPatch

conn = ConnectionPatch(xyA=(x1, y1), xyB=(x2, y2),
                       coordsA='data', coordsB='data',
                       axesA=ax1, axesB=ax2,
                       color='black', linewidth=2)
fig.add_artist(conn)
```

## Text

### Basic Text
```python
ax.text(x, y, 'Text', ha='center', va='center',
        fontsize=12, color='black', weight='bold',
        fontfamily='sans-serif', style='italic')

# ha (horizontal): 'left', 'center', 'right'
# va (vertical): 'top', 'center', 'bottom', 'baseline'
```

### Text with Background
```python
ax.text(x, y, 'Label', fontsize=10,
        bbox=dict(boxstyle='round,pad=0.3', 
                  facecolor='yellow', edgecolor='black', alpha=0.8))
```

### Rotated Text
```python
ax.text(x, y, 'Rotated', rotation=45, rotation_mode='anchor',
        ha='center', va='center')
```

### Math/LaTeX Text
```python
ax.text(x, y, r'$E = mc^2$', fontsize=14)
ax.text(x, y, r'$\int_0^1 x^2 dx$', fontsize=14)
ax.text(x, y, r'$H_2O$', fontsize=14)  # Subscript
ax.text(x, y, r'$x^{2+n}$', fontsize=14)  # Superscript
```

## Styling Tips

### Z-Order (Layering)
```python
# Lower zorder = drawn first (behind)
ax.add_patch(background_shape)  # Default zorder
line.set_zorder(5)  # On top
ax.text(..., zorder=10)  # Topmost
```

### Alpha Transparency
```python
patch = Rectangle(..., alpha=0.5)  # 50% transparent
```

### Gradient Fill (workaround)
```python
# Use imshow for gradient backgrounds
gradient = np.linspace(0, 1, 100).reshape(1, -1)
ax.imshow(gradient, extent=[x1, x2, y1, y2], aspect='auto', cmap='Blues')
```

## Common Diagram Patterns

### Node with Shadow
```python
# Shadow (slightly offset, darker)
shadow = FancyBboxPatch((x+0.1, y-0.1), w, h, 
                        boxstyle="round", facecolor='#333', alpha=0.3)
ax.add_patch(shadow)
# Main node
node = FancyBboxPatch((x, y), w, h,
                      boxstyle="round", facecolor='#3498DB')
ax.add_patch(node)
```

### Highlighted Border
```python
# Outer glow
outer = Circle((x, y), r+0.2, facecolor='none', 
               edgecolor='yellow', linewidth=4, alpha=0.5)
ax.add_patch(outer)
# Main circle
inner = Circle((x, y), r, facecolor='blue', edgecolor='white')
ax.add_patch(inner)
```
