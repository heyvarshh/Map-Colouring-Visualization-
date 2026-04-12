AI Map Coloring Visualizer

An interactive web application that demonstrates the map coloring problem using a backtracking algorithm. The project visually shows how regions (or nodes) are assigned colors such that no adjacent regions share the same color.

Overview

This project is built to understand and visualize one of the classic problems in computer science — graph coloring. Instead of just solving it in code, this application lets you see the algorithm working step by step on a map.

Features
	•	Interactive map-based visualization
	•	Real-time execution of backtracking algorithm
	•	Adjustable number of colors
	•	Step-by-step coloring and backtracking display
	•	Clean and responsive user interface

How It Works

Each region on the map is treated as a node in a graph. If two regions share a boundary, they are considered adjacent.

The algorithm:
	1.	Assigns a color to a region
	2.	Checks if it conflicts with neighboring regions
	3.	Moves forward if valid
	4.	Backtracks if no valid color is possible

This continues until all regions are successfully colored or no solution exists.

How to Run
	1.	Clone or download this repository
	2.	Open the project folder
	3.	Run index.html in any web browser

No installation or setup is required.

Technologies Used
	•	HTML
	•	CSS
	•	JavaScript
	•	D3.js (for visualization)

Project Structure
	•	index.html – main structure of the application
	•	style.css – styling and layout
	•	script.js – algorithm logic and visualization

Purpose

This project was developed as part of an AI/algorithm-focused application to better understand constraint satisfaction problems and backtracking techniques through visualization.

Author

Varsha M
