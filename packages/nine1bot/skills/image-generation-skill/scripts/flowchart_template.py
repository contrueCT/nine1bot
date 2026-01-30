#!/usr/bin/env python3
"""
Flowchart Template - Generates flowcharts with standard shapes.

Usage:
    python flowchart_template.py

Shapes:
    - oval: Start/End
    - rect: Process
    - diamond: Decision
    - parallelogram: Input/Output
"""

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Polygon, Ellipse, FancyArrowPatch
import numpy as np

# ============ CONFIGURATION ============

plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'WenQuanYi Zen Hei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

COLORS = {
    'start_end': '#2ECC71',
    'process': '#3498DB',
    'decision': '#F39C12',
    'io': '#9B59B6',
    'connector': '#7F8C8D',
    'text': '#FFFFFF',
    'arrow': '#2C3E50'
}

# ============ SHAPE FUNCTIONS ============

def draw_oval(ax, x, y, text, width=2.5, height=1.0, color=None):
    """Draw oval (Start/End node)."""
    color = color or COLORS['start_end']
    ellipse = Ellipse((x, y), width, height, facecolor=color, 
                      edgecolor='white', linewidth=2)
    ax.add_patch(ellipse)
    ax.text(x, y, text, ha='center', va='center', 
            fontsize=11, color=COLORS['text'], weight='bold')
    return {'center': (x, y), 'top': (x, y + height/2), 
            'bottom': (x, y - height/2), 'left': (x - width/2, y), 
            'right': (x + width/2, y)}

def draw_rect(ax, x, y, text, width=3.0, height=1.2, color=None):
    """Draw rectangle (Process node)."""
    color = color or COLORS['process']
    box = FancyBboxPatch((x - width/2, y - height/2), width, height,
                         boxstyle="round,pad=0.05,rounding_size=0.15",
                         facecolor=color, edgecolor='white', linewidth=2)
    ax.add_patch(box)
    ax.text(x, y, text, ha='center', va='center',
            fontsize=10, color=COLORS['text'], weight='bold')
    return {'center': (x, y), 'top': (x, y + height/2),
            'bottom': (x, y - height/2), 'left': (x - width/2, y),
            'right': (x + width/2, y)}

def draw_diamond(ax, x, y, text, size=1.8, color=None):
    """Draw diamond (Decision node)."""
    color = color or COLORS['decision']
    half = size / 2
    vertices = [(x, y + half), (x + half, y), (x, y - half), (x - half, y)]
    diamond = Polygon(vertices, facecolor=color, edgecolor='white', linewidth=2)
    ax.add_patch(diamond)
    ax.text(x, y, text, ha='center', va='center',
            fontsize=9, color=COLORS['text'], weight='bold')
    return {'center': (x, y), 'top': (x, y + half),
            'bottom': (x, y - half), 'left': (x - half, y),
            'right': (x + half, y)}

def draw_parallelogram(ax, x, y, text, width=3.0, height=1.0, skew=0.3, color=None):
    """Draw parallelogram (Input/Output node)."""
    color = color or COLORS['io']
    offset = width * skew
    vertices = [
        (x - width/2 + offset, y + height/2),
        (x + width/2 + offset, y + height/2),
        (x + width/2 - offset, y - height/2),
        (x - width/2 - offset, y - height/2)
    ]
    para = Polygon(vertices, facecolor=color, edgecolor='white', linewidth=2)
    ax.add_patch(para)
    ax.text(x, y, text, ha='center', va='center',
            fontsize=10, color=COLORS['text'], weight='bold')
    return {'center': (x, y), 'top': (x, y + height/2),
            'bottom': (x, y - height/2), 'left': (x - width/2, y),
            'right': (x + width/2, y)}

def draw_arrow(ax, start, end, label='', curved=False):
    """Draw arrow between two points."""
    style = "Simple,tail_width=0.5,head_width=4,head_length=6"
    
    if curved:
        connectionstyle = "arc3,rad=0.2"
    else:
        connectionstyle = "arc3,rad=0"
    
    arrow = FancyArrowPatch(start, end, arrowstyle='-|>',
                            connectionstyle=connectionstyle,
                            color=COLORS['arrow'], linewidth=1.5,
                            mutation_scale=15)
    ax.add_patch(arrow)
    
    if label:
        mid_x = (start[0] + end[0]) / 2
        mid_y = (start[1] + end[1]) / 2
        ax.text(mid_x + 0.2, mid_y, label, fontsize=9, color='#333',
                ha='left', va='center')

# ============ FLOWCHART BUILDER ============

def create_flowchart(steps, output_path='flowchart.png', figsize=(10, 14), dpi=150):
    """
    Create a flowchart from step definitions.
    
    Args:
        steps: list of dicts with structure:
            {
                'type': 'start'|'process'|'decision'|'io'|'end',
                'text': 'Node text',
                'yes_to': index or None,  # For decisions
                'no_to': index or None,   # For decisions
                'next': index or None     # For other nodes
            }
        output_path: output file path
    """
    fig, ax = plt.subplots(figsize=figsize, dpi=dpi)
    
    # Calculate layout
    n_steps = len(steps)
    height = max(14, n_steps * 2.5)
    width = 10
    
    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.set_aspect('equal')
    ax.axis('off')
    
    # Position nodes vertically
    y_spacing = (height - 2) / (n_steps + 1)
    x_center = width / 2
    
    nodes = []
    for i, step in enumerate(steps):
        y = height - 1 - (i + 1) * y_spacing
        x = x_center
        
        # Offset for decision branches if needed
        if step.get('branch') == 'yes':
            x = x_center - 2
        elif step.get('branch') == 'no':
            x = x_center + 2
        
        # Draw appropriate shape
        if step['type'] in ['start', 'end']:
            node = draw_oval(ax, x, y, step['text'])
        elif step['type'] == 'process':
            node = draw_rect(ax, x, y, step['text'])
        elif step['type'] == 'decision':
            node = draw_diamond(ax, x, y, step['text'])
        elif step['type'] == 'io':
            node = draw_parallelogram(ax, x, y, step['text'])
        else:
            node = draw_rect(ax, x, y, step['text'])
        
        nodes.append(node)
    
    # Draw connections
    for i, step in enumerate(steps):
        if step['type'] == 'decision':
            # Decision has yes/no branches
            yes_idx = step.get('yes_to')
            no_idx = step.get('no_to')
            
            if yes_idx is not None and yes_idx < len(nodes):
                draw_arrow(ax, nodes[i]['left'], nodes[yes_idx]['top'], 'Yes', curved=True)
            if no_idx is not None and no_idx < len(nodes):
                draw_arrow(ax, nodes[i]['right'], nodes[no_idx]['top'], 'No', curved=True)
        else:
            # Regular node connects to next
            next_idx = step.get('next')
            if next_idx is not None and next_idx < len(nodes):
                draw_arrow(ax, nodes[i]['bottom'], nodes[next_idx]['top'])
    
    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight', facecolor='white', edgecolor='none')
    plt.close()
    
    print(f"Flowchart saved to: {output_path}")

# ============ SIMPLE LINEAR FLOWCHART ============

def create_linear_flowchart(items, output_path='flowchart.png', title=''):
    """
    Create a simple linear flowchart (no branches).
    
    Args:
        items: list of tuples (type, text)
               type: 'start', 'process', 'decision', 'io', 'end'
    """
    fig, ax = plt.subplots(figsize=(8, len(items) * 2 + 2), dpi=150)
    
    height = len(items) * 2 + 2
    ax.set_xlim(0, 8)
    ax.set_ylim(0, height)
    ax.set_aspect('equal')
    ax.axis('off')
    
    if title:
        ax.text(4, height - 0.5, title, ha='center', va='top',
                fontsize=14, weight='bold', color='#2C3E50')
    
    nodes = []
    for i, (node_type, text) in enumerate(items):
        y = height - 2 - i * 2
        x = 4
        
        if node_type in ['start', 'end']:
            node = draw_oval(ax, x, y, text)
        elif node_type == 'decision':
            node = draw_diamond(ax, x, y, text)
        elif node_type == 'io':
            node = draw_parallelogram(ax, x, y, text)
        else:
            node = draw_rect(ax, x, y, text)
        
        nodes.append(node)
        
        # Connect to previous
        if i > 0:
            draw_arrow(ax, nodes[i-1]['bottom'], node['top'])
    
    plt.savefig(output_path, bbox_inches='tight', facecolor='white', edgecolor='none')
    plt.close()
    print(f"Flowchart saved to: {output_path}")

# ============ EXAMPLE USAGE ============

if __name__ == '__main__':
    # Example: Login process flowchart
    items = [
        ('start', 'Start'),
        ('io', 'Enter Username\n& Password'),
        ('process', 'Validate\nCredentials'),
        ('decision', 'Valid?'),
        ('process', 'Grant Access'),
        ('end', 'End')
    ]
    
    create_linear_flowchart(items, 'login_flowchart.png', 'Login Process')
