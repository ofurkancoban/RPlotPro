# R Plot Pro - Julia 20 Plot Capture Test
# Sadece base Plots.jl (GR backend) - ek paket gerektirmez
using Plots, Statistics
gr()

x = range(0, 2π, length=200)

# Plot 1: Scatter
display(scatter(rand(80), rand(80),
    title="Plot 1: Scatter", xlabel="x", ylabel="y",
    legend=false, color=:steelblue, markersize=5))

# Plot 2: Line - sin
display(plot(x, sin.(x),
    title="Plot 2: sin(x)", lw=2, color=:purple, legend=false))

# Plot 3: Histogram
display(histogram(randn(500),
    title="Plot 3: Histogram - Normal", bins=30,
    color=:tomato, legend=false))

# Plot 4: Bar chart
display(bar(["A","B","C","D","E"], [23,45,12,67,34],
    title="Plot 4: Bar Chart",
    color=[:coral,:steelblue,:gold,:salmon,:mediumseagreen],
    legend=false))

# Plot 5: Multi-line
display(plot(x, [sin.(x) cos.(x) sin.(2x) cos.(2x)],
    title="Plot 5: Multi Line",
    label=["sin(x)" "cos(x)" "sin(2x)" "cos(2x)"], lw=2))

# Plot 6: Area fill
display(plot(x, sin.(x),
    title="Plot 6: Filled Area",
    fillrange=0, fillalpha=0.35,
    color=:navy, legend=false))

# Plot 7: Scatter with color gradient
n = 200
xr, yr = randn(n), randn(n)
display(scatter(xr, yr,
    title="Plot 7: Scatter Gradient",
    zcolor=xr.^2 .+ yr.^2, color=:viridis,
    markersize=4, legend=false, colorbar=true))

# Plot 8: Heatmap
display(heatmap(rand(12,12),
    title="Plot 8: Heatmap", color=:hot))

# Plot 9: Contour
f(x,y) = sin(x)*cos(y)
xs = range(-π, π, length=100)
ys = range(-π, π, length=100)
display(contourf(xs, ys, f,
    title="Plot 9: Contour - sin(x)cos(y)",
    color=:plasma, levels=20))

# Plot 10: Pie
display(pie(["Alpha","Beta","Gamma","Delta","Epsilon"],
    [30,25,20,15,10], title="Plot 10: Pie Chart"))

# Plot 11: Step plot
display(plot(x[1:3:end], sin.(x[1:3:end]),
    title="Plot 11: Step Plot",
    seriestype=:steppost, color=:darkred, lw=2, legend=false))

# Plot 12: Stacked bar
data12 = [10 20 30; 15 25 10; 5 10 25; 20 15 20]
display(bar(["Q1","Q2","Q3","Q4"], data12,
    title="Plot 12: Stacked Bar",
    bar_position=:stack,
    label=["Prod A" "Prod B" "Prod C"]))

# Plot 13: Scatter + smooth trend
x13 = randn(120)
y13 = x13 .* 1.8 .+ randn(120) .* 0.6
display(scatter(x13, y13,
    title="Plot 13: Scatter + Trend",
    legend=false, color=:coral, markersize=4, smooth=true))

# Plot 14: Manuel KDE
function kde(data, xs)
    h = 1.06 * std(data) * length(data)^(-0.2)
    [mean(exp.(-0.5 .* ((xi .- data)./h).^2) ./ (h*sqrt(2π))) for xi in xs]
end
xs14 = range(-5, 5, length=200)
g1, g2, g3 = randn(300), randn(300).+2, randn(300).-2
display(plot(xs14, [kde(g1,xs14) kde(g2,xs14) kde(g3,xs14)],
    title="Plot 14: KDE - 3 Groups",
    label=["G1" "G2" "G3"], lw=2, fill=(0,0.15)))

# Plot 15: Parametric spiral
t = range(0, 4π, length=400)
display(plot(t.*cos.(t), t.*sin.(t),
    title="Plot 15: Archimedean Spiral",
    line_z=t, color=:inferno, lw=1.5, legend=false))

# Plot 16: Error bars
xp = 1:10
yp = sin.(xp)
display(plot(xp, yp,
    title="Plot 16: Error Bars",
    yerror=0.15*rand(10), xerror=0.1*rand(10),
    marker=:circle, color=:steelblue, legend=false))

# Plot 17: 3D Surface
xs3 = range(-2, 2, length=40)
ys3 = range(-2, 2, length=40)
display(surface(xs3, ys3, (x,y)->exp(-(x^2+y^2)),
    title="Plot 17: 3D Gaussian Surface", color=:viridis))

# Plot 18: 3D Scatter
display(scatter3d(randn(100), randn(100), randn(100),
    title="Plot 18: 3D Scatter",
    marker_z=randn(100), color=:plasma,
    markersize=3, legend=false))

# Plot 19: Annotated plot
display(plot(x, cos.(x),
    title="Plot 19: Annotated cos(x)",
    lw=2, color=:teal, legend=false,
    annotations=[
        (π/2,  0.05, text("π/2",  10, :left, :red)),
        (π,   -0.05, text("π",    10, :right, :blue)),
        (3π/2, 0.05, text("3π/2", 10, :left, :green)),
    ]))

# Plot 20: 2×2 Subplot (tek parça)
p1 = plot(x, sin.(x),   title="sin",  lw=2, legend=false)
p2 = plot(x, cos.(x),   title="cos",  lw=2, legend=false, color=:red)
p3 = histogram(randn(300), title="hist", bins=20, legend=false, color=:gold)
p4 = scatter(randn(60), randn(60), title="scatter", legend=false, color=:teal)
display(plot(p1, p2, p3, p4,
    layout=(2,2), plot_title="Plot 20: 2×2 Subplots"))

println("Test tamamlandi. 20 plot bekleniyor.")
