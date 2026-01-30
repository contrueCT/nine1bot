#!/usr/bin/env python3
"""
Chart Templates - Common data visualization patterns.

Includes: bar, pie, line, scatter, heatmap, radar charts.
"""

import matplotlib.pyplot as plt
import numpy as np

# ============ CONFIGURATION ============

plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'WenQuanYi Zen Hei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

COLORS = ['#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6',
          '#1ABC9C', '#E67E22', '#16A085', '#8E44AD', '#2980B9']

# ============ CHART FUNCTIONS ============

def bar_chart(categories, values, title='', xlabel='', ylabel='', 
              horizontal=False, output_path='bar_chart.png'):
    """Create a bar chart."""
    fig, ax = plt.subplots(figsize=(10, 6), dpi=150)
    
    colors = COLORS[:len(categories)]
    
    if horizontal:
        bars = ax.barh(categories, values, color=colors)
        ax.set_xlabel(ylabel or 'Value')
        ax.set_ylabel(xlabel or 'Category')
    else:
        bars = ax.bar(categories, values, color=colors)
        ax.set_xlabel(xlabel or 'Category')
        ax.set_ylabel(ylabel or 'Value')
    
    # Add value labels
    for bar, val in zip(bars, values):
        if horizontal:
            ax.text(val + max(values)*0.01, bar.get_y() + bar.get_height()/2,
                   f'{val}', va='center', fontsize=10)
        else:
            ax.text(bar.get_x() + bar.get_width()/2, val + max(values)*0.01,
                   f'{val}', ha='center', fontsize=10)
    
    ax.set_title(title, fontsize=14, weight='bold', pad=15)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight', facecolor='white')
    plt.close()
    print(f"Bar chart saved to: {output_path}")


def pie_chart(labels, sizes, title='', output_path='pie_chart.png', 
              explode=None, donut=False):
    """Create a pie or donut chart."""
    fig, ax = plt.subplots(figsize=(10, 8), dpi=150)
    
    colors = COLORS[:len(labels)]
    
    wedges, texts, autotexts = ax.pie(
        sizes, labels=labels, autopct='%1.1f%%', colors=colors,
        explode=explode, startangle=90,
        wedgeprops={'edgecolor': 'white', 'linewidth': 2}
    )
    
    # Make percentage text bold
    for autotext in autotexts:
        autotext.set_fontsize(10)
        autotext.set_weight('bold')
    
    if donut:
        centre_circle = plt.Circle((0, 0), 0.5, fc='white')
        ax.add_patch(centre_circle)
    
    ax.set_title(title, fontsize=14, weight='bold', pad=20)
    
    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight', facecolor='white')
    plt.close()
    print(f"Pie chart saved to: {output_path}")


def line_chart(x, y_series, labels=None, title='', xlabel='', ylabel='',
               output_path='line_chart.png', markers=True):
    """
    Create a line chart with multiple series.
    
    Args:
        x: x-axis values
        y_series: list of y-axis value arrays (one per line)
        labels: list of labels for each series
    """
    fig, ax = plt.subplots(figsize=(12, 6), dpi=150)
    
    if not isinstance(y_series[0], (list, np.ndarray)):
        y_series = [y_series]
    
    labels = labels or [f'Series {i+1}' for i in range(len(y_series))]
    
    for i, (y, label) in enumerate(zip(y_series, labels)):
        marker = 'o' if markers else None
        ax.plot(x, y, color=COLORS[i % len(COLORS)], label=label,
                linewidth=2, marker=marker, markersize=6)
    
    ax.set_xlabel(xlabel, fontsize=12)
    ax.set_ylabel(ylabel, fontsize=12)
    ax.set_title(title, fontsize=14, weight='bold', pad=15)
    ax.legend(loc='best')
    ax.grid(True, alpha=0.3)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight', facecolor='white')
    plt.close()
    print(f"Line chart saved to: {output_path}")


def scatter_chart(x, y, sizes=None, colors=None, labels=None, title='',
                  xlabel='', ylabel='', output_path='scatter_chart.png'):
    """Create a scatter plot with optional size/color encoding."""
    fig, ax = plt.subplots(figsize=(10, 8), dpi=150)
    
    sizes = sizes or 100
    colors = colors or COLORS[0]
    
    scatter = ax.scatter(x, y, s=sizes, c=colors, alpha=0.6, edgecolors='white')
    
    if labels:
        for i, label in enumerate(labels):
            ax.annotate(label, (x[i], y[i]), fontsize=8, 
                       xytext=(5, 5), textcoords='offset points')
    
    ax.set_xlabel(xlabel, fontsize=12)
    ax.set_ylabel(ylabel, fontsize=12)
    ax.set_title(title, fontsize=14, weight='bold', pad=15)
    ax.grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight', facecolor='white')
    plt.close()
    print(f"Scatter chart saved to: {output_path}")


def heatmap(data, row_labels, col_labels, title='', output_path='heatmap.png',
            cmap='YlOrRd', annotate=True):
    """Create a heatmap with optional annotations."""
    fig, ax = plt.subplots(figsize=(10, 8), dpi=150)
    
    im = ax.imshow(data, cmap=cmap, aspect='auto')
    
    ax.set_xticks(range(len(col_labels)))
    ax.set_yticks(range(len(row_labels)))
    ax.set_xticklabels(col_labels)
    ax.set_yticklabels(row_labels)
    
    plt.setp(ax.get_xticklabels(), rotation=45, ha='right')
    
    if annotate:
        for i in range(len(row_labels)):
            for j in range(len(col_labels)):
                val = data[i, j]
                color = 'white' if val > np.mean(data) else 'black'
                ax.text(j, i, f'{val:.1f}', ha='center', va='center',
                       color=color, fontsize=9)
    
    cbar = plt.colorbar(im)
    ax.set_title(title, fontsize=14, weight='bold', pad=15)
    
    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight', facecolor='white')
    plt.close()
    print(f"Heatmap saved to: {output_path}")


def radar_chart(categories, values, title='', output_path='radar_chart.png',
                fill=True, max_value=None):
    """Create a radar/spider chart."""
    fig, ax = plt.subplots(figsize=(8, 8), dpi=150, subplot_kw=dict(polar=True))
    
    n = len(categories)
    angles = [i * 2 * np.pi / n for i in range(n)]
    angles += angles[:1]  # Complete the loop
    
    values_plot = list(values) + [values[0]]  # Complete the loop
    
    ax.plot(angles, values_plot, 'o-', linewidth=2, color=COLORS[0])
    
    if fill:
        ax.fill(angles, values_plot, alpha=0.25, color=COLORS[0])
    
    ax.set_xticks(angles[:-1])
    ax.set_xticklabels(categories, fontsize=10)
    
    if max_value:
        ax.set_ylim(0, max_value)
    
    ax.set_title(title, fontsize=14, weight='bold', pad=20)
    
    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight', facecolor='white')
    plt.close()
    print(f"Radar chart saved to: {output_path}")


def comparison_bar(categories, series_data, series_labels, title='',
                   xlabel='', ylabel='', output_path='comparison_bar.png'):
    """Create grouped bar chart for comparison."""
    fig, ax = plt.subplots(figsize=(12, 6), dpi=150)
    
    n_series = len(series_data)
    n_categories = len(categories)
    bar_width = 0.8 / n_series
    
    x = np.arange(n_categories)
    
    for i, (data, label) in enumerate(zip(series_data, series_labels)):
        offset = (i - n_series/2 + 0.5) * bar_width
        ax.bar(x + offset, data, bar_width, label=label, color=COLORS[i])
    
    ax.set_xlabel(xlabel, fontsize=12)
    ax.set_ylabel(ylabel, fontsize=12)
    ax.set_title(title, fontsize=14, weight='bold', pad=15)
    ax.set_xticks(x)
    ax.set_xticklabels(categories)
    ax.legend()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight', facecolor='white')
    plt.close()
    print(f"Comparison bar chart saved to: {output_path}")


# ============ EXAMPLE USAGE ============

if __name__ == '__main__':
    # Bar chart example
    bar_chart(
        ['A', 'B', 'C', 'D', 'E'],
        [23, 45, 56, 78, 32],
        title='Sales by Region',
        ylabel='Sales (millions)',
        output_path='example_bar.png'
    )
    
    # Pie chart example
    pie_chart(
        ['Product A', 'Product B', 'Product C', 'Product D'],
        [35, 25, 25, 15],
        title='Market Share',
        output_path='example_pie.png'
    )
    
    # Line chart example
    x = list(range(1, 13))
    y1 = [10, 15, 13, 18, 22, 25, 30, 28, 32, 35, 38, 42]
    y2 = [8, 12, 10, 14, 18, 20, 24, 22, 26, 28, 30, 34]
    line_chart(
        x, [y1, y2], 
        labels=['2023', '2022'],
        title='Monthly Growth',
        xlabel='Month',
        ylabel='Revenue',
        output_path='example_line.png'
    )
    
    # Radar chart example
    radar_chart(
        ['Speed', 'Power', 'Defense', 'Accuracy', 'Stamina'],
        [85, 70, 90, 75, 80],
        title='Player Stats',
        output_path='example_radar.png',
        max_value=100
    )
