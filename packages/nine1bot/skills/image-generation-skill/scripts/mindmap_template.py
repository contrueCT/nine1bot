#!/usr/bin/env python3
"""
Mind Map Template - Generates hierarchical mind maps with matplotlib.

Usage:
    python mindmap_template.py

Customization:
    1. Modify `data` dictionary with your content
    2. Adjust colors in `COLORS` dict
    3. Change layout by modifying position calculations
"""

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import numpy as np

# ============ CONFIGURATION ============

# Font setup for Chinese support
plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'WenQuanYi Zen Hei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

# Color palette
COLORS = {
    'center': '#E74C3C',
    'branch1': '#3498DB',
    'branch2': '#2ECC71', 
    'branch3': '#F39C12',
    'branch4': '#9B59B6',
    'branch5': '#1ABC9C',
    'connector': '#7F8C8D',
    'background': '#FFFFFF'
}

# ============ DRAWING FUNCTIONS ============

def draw_node(ax, x, y, text, color, width=2.5, height=0.8, fontsize=11, alpha=0.9):
    """Draw a rounded rectangle node with centered text."""
    box = FancyBboxPatch(
        (x - width/2, y - height/2), width, height,
        boxstyle="round,pad=0.05,rounding_size=0.2",
        facecolor=color, edgecolor='white', linewidth=2, alpha=alpha
    )
    ax.add_patch(box)
    
    # Handle multi-line text
    lines = text.split('\n')
    line_height = 0.25
    start_y = y + (len(lines) - 1) * line_height / 2
    
    for i, line in enumerate(lines):
        ax.text(x, start_y - i * line_height, line, 
                ha='center', va='center', fontsize=fontsize,
                color='white', weight='bold')

def draw_connector(ax, start, end, color='#7F8C8D', linewidth=2.5):
    """Draw a curved connector line between two points."""
    ax.plot([start[0], end[0]], [start[1], end[1]], 
            color=color, linewidth=linewidth, alpha=0.6, zorder=0)

def draw_label(ax, x, y, text, fontsize=9, bgcolor='#FFFDE7', bordercolor='#FFD54F'):
    """Draw a formula or label with background."""
    ax.text(x, y, text, ha='center', va='center', fontsize=fontsize,
            color='#333333', style='italic',
            bbox=dict(boxstyle='round,pad=0.3', facecolor=bgcolor, 
                     edgecolor=bordercolor, alpha=0.9))

# ============ LAYOUT FUNCTIONS ============

def radial_layout(center, radius, count, start_angle=90):
    """Calculate positions in a radial/circular layout."""
    positions = []
    angle_step = 360 / count
    for i in range(count):
        angle = np.radians(start_angle + i * angle_step)
        x = center[0] + radius * np.cos(angle)
        y = center[1] + radius * np.sin(angle)
        positions.append((x, y))
    return positions

def tree_layout(parent_pos, count, spread=2.5, offset_y=-2):
    """Calculate positions for child nodes in a tree layout."""
    positions = []
    if count == 1:
        positions.append((parent_pos[0], parent_pos[1] + offset_y))
    else:
        start_x = parent_pos[0] - spread * (count - 1) / 2
        for i in range(count):
            x = start_x + i * spread
            y = parent_pos[1] + offset_y
            positions.append((x, y))
    return positions

# ============ MAIN RENDERING ============

def create_mindmap(data, output_path='mindmap.png', figsize=(16, 12), dpi=150):
    """
    Create a mind map from structured data.
    
    Args:
        data: dict with structure:
            {
                'title': 'Center Topic',
                'branches': [
                    {
                        'name': 'Branch 1',
                        'color': '#3498DB',
                        'children': ['Child 1', 'Child 2']
                    },
                    ...
                ]
            }
        output_path: output file path
        figsize: figure size tuple
        dpi: resolution
    """
    fig, ax = plt.subplots(figsize=figsize, dpi=dpi)
    
    # Calculate canvas bounds based on content
    n_branches = len(data['branches'])
    max_children = max(len(b.get('children', [])) for b in data['branches']) if data['branches'] else 0
    
    width = max(16, n_branches * 3)
    height = max(12, 4 + max_children * 1.5)
    
    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.set_aspect('equal')
    ax.axis('off')
    
    center = (width / 2, height / 2)
    
    # Draw center node
    draw_node(ax, center[0], center[1], data['title'], 
              COLORS['center'], width=3.5, height=1.2, fontsize=14)
    
    # Draw branches
    branch_radius = min(width, height) / 3
    branch_positions = radial_layout(center, branch_radius, n_branches)
    
    color_keys = ['branch1', 'branch2', 'branch3', 'branch4', 'branch5']
    
    for i, (branch, pos) in enumerate(zip(data['branches'], branch_positions)):
        color = branch.get('color', COLORS[color_keys[i % len(color_keys)]])
        
        # Draw connector to center
        draw_connector(ax, center, pos, color=color, linewidth=3)
        
        # Draw branch node
        draw_node(ax, pos[0], pos[1], branch['name'], color, width=2.8)
        
        # Draw children if any
        children = branch.get('children', [])
        if children:
            # Position children further from center
            direction = np.array([pos[0] - center[0], pos[1] - center[1]])
            direction = direction / np.linalg.norm(direction)
            
            child_base = (pos[0] + direction[0] * 2, pos[1] + direction[1] * 2)
            
            # Spread children perpendicular to branch direction
            perp = np.array([-direction[1], direction[0]])
            spread = 1.2
            
            for j, child in enumerate(children):
                offset = (j - (len(children) - 1) / 2) * spread
                child_pos = (child_base[0] + perp[0] * offset, 
                            child_base[1] + perp[1] * offset)
                
                draw_connector(ax, pos, child_pos, color=color, linewidth=1.5)
                draw_node(ax, child_pos[0], child_pos[1], child, 
                         color, width=2.2, height=0.6, fontsize=9, alpha=0.85)
    
    # Add title
    ax.text(width/2, height - 0.5, data.get('header', ''), 
            ha='center', va='top', fontsize=16, weight='bold', color='#2C3E50')
    
    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight', facecolor='white', edgecolor='none')
    plt.close()
    
    print(f"Mind map saved to: {output_path}")

# ============ EXAMPLE USAGE ============

if __name__ == '__main__':
    # Example: Physics concepts mind map
    example_data = {
        'header': 'Physics Mind Map',
        'title': 'Classical\nMechanics',
        'branches': [
            {
                'name': 'Kinematics',
                'color': '#3498DB',
                'children': ['Position', 'Velocity', 'Acceleration']
            },
            {
                'name': 'Dynamics',
                'color': '#E74C3C',
                'children': ["Newton's Laws", 'Force', 'Momentum']
            },
            {
                'name': 'Energy',
                'color': '#2ECC71',
                'children': ['Kinetic', 'Potential', 'Conservation']
            },
            {
                'name': 'Rotation',
                'color': '#F39C12',
                'children': ['Torque', 'Angular Momentum', 'Inertia']
            },
            {
                'name': 'Oscillations',
                'color': '#9B59B6',
                'children': ['SHM', 'Damping', 'Resonance']
            }
        ]
    }
    
    create_mindmap(example_data, 'physics_mindmap.png')
