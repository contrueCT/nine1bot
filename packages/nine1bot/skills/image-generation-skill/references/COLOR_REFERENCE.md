# Color Reference for Image Generation

## Professional Color Palettes

### Flat UI Colors
```python
FLAT_COLORS = {
    'turquoise': '#1ABC9C',
    'emerald': '#2ECC71',
    'peter_river': '#3498DB',
    'amethyst': '#9B59B6',
    'wet_asphalt': '#34495E',
    'green_sea': '#16A085',
    'nephritis': '#27AE60',
    'belize_hole': '#2980B9',
    'wisteria': '#8E44AD',
    'midnight_blue': '#2C3E50',
    'sun_flower': '#F1C40F',
    'carrot': '#E67E22',
    'alizarin': '#E74C3C',
    'clouds': '#ECF0F1',
    'concrete': '#95A5A6',
    'orange': '#F39C12',
    'pumpkin': '#D35400',
    'pomegranate': '#C0392B',
    'silver': '#BDC3C7',
    'asbestos': '#7F8C8D'
}
```

### Material Design Colors
```python
MATERIAL = {
    'red': '#F44336',
    'pink': '#E91E63',
    'purple': '#9C27B0',
    'deep_purple': '#673AB7',
    'indigo': '#3F51B5',
    'blue': '#2196F3',
    'light_blue': '#03A9F4',
    'cyan': '#00BCD4',
    'teal': '#009688',
    'green': '#4CAF50',
    'light_green': '#8BC34A',
    'lime': '#CDDC39',
    'yellow': '#FFEB3B',
    'amber': '#FFC107',
    'orange': '#FF9800',
    'deep_orange': '#FF5722',
    'brown': '#795548',
    'grey': '#9E9E9E',
    'blue_grey': '#607D8B'
}
```

### Categorical Palettes (for charts)
```python
# 10-color categorical (good contrast)
CATEGORICAL_10 = [
    '#E74C3C',  # Red
    '#3498DB',  # Blue
    '#2ECC71',  # Green
    '#F39C12',  # Orange
    '#9B59B6',  # Purple
    '#1ABC9C',  # Teal
    '#E67E22',  # Dark Orange
    '#16A085',  # Dark Teal
    '#8E44AD',  # Dark Purple
    '#2980B9'   # Dark Blue
]

# Pastel palette (softer)
PASTEL = [
    '#FF6B6B',  # Coral
    '#4ECDC4',  # Mint
    '#45B7D1',  # Sky Blue
    '#96CEB4',  # Sage
    '#FFEAA7',  # Cream Yellow
    '#DDA0DD',  # Plum
    '#98D8C8',  # Seafoam
    '#F7DC6F',  # Soft Yellow
    '#BB8FCE',  # Lavender
    '#85C1E9'   # Light Blue
]

# Bold/Vibrant
VIBRANT = [
    '#FF0000',  # Pure Red
    '#00FF00',  # Lime
    '#0000FF',  # Blue
    '#FFFF00',  # Yellow
    '#FF00FF',  # Magenta
    '#00FFFF',  # Cyan
    '#FF8000',  # Orange
    '#8000FF',  # Violet
    '#00FF80',  # Spring Green
    '#FF0080'   # Rose
]
```

### Sequential Palettes (for gradients/heatmaps)
```python
# Use matplotlib colormaps:
# Perceptually uniform: 'viridis', 'plasma', 'inferno', 'magma', 'cividis'
# Sequential: 'Blues', 'Greens', 'Oranges', 'Reds', 'Purples', 'Greys'
# Diverging: 'RdBu', 'RdYlGn', 'BrBG', 'PiYG', 'coolwarm'

import matplotlib.pyplot as plt
import numpy as np

# Get colors from colormap
cmap = plt.cm.viridis
colors = [cmap(i/n) for i in range(n)]

# Or for specific values
color = plt.cm.Blues(0.6)  # 60% along Blues colormap
```

### Monochromatic Palettes
```python
# Blue monochrome
BLUE_MONO = ['#EBF5FB', '#AED6F1', '#5DADE2', '#2E86C1', '#1B4F72']

# Green monochrome  
GREEN_MONO = ['#E9F7EF', '#A9DFBF', '#52BE80', '#27AE60', '#145A32']

# Gray monochrome
GRAY_MONO = ['#F8F9F9', '#D5D8DC', '#ABB2B9', '#717D7E', '#2C3E50']

# Generate monochromatic from base color
def monochrome_palette(base_hex, n=5):
    """Generate n shades from light to dark."""
    import colorsys
    
    # Convert hex to RGB to HSV
    r, g, b = int(base_hex[1:3], 16)/255, int(base_hex[3:5], 16)/255, int(base_hex[5:7], 16)/255
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    
    colors = []
    for i in range(n):
        new_v = 0.95 - (i * 0.7 / (n-1))  # Light to dark
        new_s = 0.2 + (i * 0.6 / (n-1))   # Low to high saturation
        r, g, b = colorsys.hsv_to_rgb(h, min(new_s, 1), max(new_v, 0.2))
        colors.append(f'#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}')
    return colors
```

## Color Usage Guidelines

### Semantic Colors
```python
SEMANTIC = {
    'success': '#2ECC71',
    'warning': '#F39C12', 
    'danger': '#E74C3C',
    'info': '#3498DB',
    'neutral': '#95A5A6',
    'highlight': '#F1C40F'
}
```

### Background Colors
```python
BACKGROUNDS = {
    'white': '#FFFFFF',
    'off_white': '#FAFAFA',
    'light_gray': '#F5F5F5',
    'paper': '#FFFDE7',
    'dark': '#2C3E50',
    'black': '#1A1A1A'
}
```

### Text Colors
```python
TEXT = {
    'primary': '#2C3E50',      # Main text
    'secondary': '#7F8C8D',    # Subdued text
    'on_dark': '#FFFFFF',      # Text on dark backgrounds
    'on_light': '#333333',     # Text on light backgrounds
    'link': '#3498DB',         # Links
    'muted': '#BDC3C7'         # Very light text
}
```

## Color Contrast Tips

1. **Text Readability**: Ensure sufficient contrast ratio
   - Normal text: 4.5:1 minimum
   - Large text: 3:1 minimum
   
2. **Adjacent Colors**: Avoid putting similar colors next to each other

3. **Colorblind Safe**: Avoid relying solely on red-green distinction
   - Use shapes, patterns, or labels as backup
   - Safe palette: blue, orange, purple, gray
   
4. **Print Friendly**: Test with grayscale conversion

## Quick Color Functions

```python
def hex_to_rgb(hex_color):
    """Convert #RRGGBB to (r, g, b) tuple (0-255)."""
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))

def rgb_to_hex(r, g, b):
    """Convert (r, g, b) to #RRGGBB."""
    return f'#{r:02x}{g:02x}{b:02x}'

def lighten(hex_color, factor=0.3):
    """Lighten a color by factor (0-1)."""
    r, g, b = hex_to_rgb(hex_color)
    r = int(r + (255 - r) * factor)
    g = int(g + (255 - g) * factor)
    b = int(b + (255 - b) * factor)
    return rgb_to_hex(r, g, b)

def darken(hex_color, factor=0.3):
    """Darken a color by factor (0-1)."""
    r, g, b = hex_to_rgb(hex_color)
    r = int(r * (1 - factor))
    g = int(g * (1 - factor))
    b = int(b * (1 - factor))
    return rgb_to_hex(r, g, b)

def with_alpha(hex_color, alpha):
    """Convert hex to rgba string for matplotlib."""
    r, g, b = hex_to_rgb(hex_color)
    return (r/255, g/255, b/255, alpha)
```
