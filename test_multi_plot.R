# R Plot Pro - 20 Plot Capture Test
library(ggplot2)

# --- Base R Plots ---

# Plot 1: Scatter
plot(cars, main = "Plot 1: cars - Scatter", col = "steelblue", pch = 19)

# Plot 2: Histogram
hist(rnorm(500), main = "Plot 2: Normal Dist - Histogram",
     col = "tomato", border = "white", breaks = 30)

# Plot 3: Boxplot
boxplot(mpg ~ cyl, data = mtcars, main = "Plot 3: mtcars - Boxplot",
        col = c("gold", "skyblue", "salmon"))

# Plot 4: Line
x <- seq(0, 2 * pi, length.out = 200)
plot(x, sin(x), type = "l", lwd = 2, col = "purple",
     main = "Plot 4: sin(x) - Line", ylab = "sin(x)")

# Plot 5: Multiple lines
plot(x, cos(x), type = "l", lwd = 2, col = "darkgreen",
     main = "Plot 5: sin & cos - Multi Line", ylab = "")
lines(x, sin(x), col = "red", lwd = 2)
legend("topright", legend = c("cos", "sin"), col = c("darkgreen", "red"), lwd = 2)

# Plot 6: Bar chart
barplot(table(mtcars$cyl), main = "Plot 6: Cylinder Counts - Bar",
        col = c("coral", "steelblue", "gold"), ylab = "Count")

# Plot 7: Pie chart
pie(c(30, 25, 20, 15, 10),
    labels = c("A", "B", "C", "D", "E"),
    col = rainbow(5),
    main = "Plot 7: Pie Chart")

# Plot 8: Density
plot(density(rnorm(1000)), main = "Plot 8: Density - Normal",
     col = "navy", lwd = 2)

# Plot 9: QQ plot
qqnorm(rnorm(200), main = "Plot 9: QQ Normal Plot")
qqline(rnorm(200), col = "red")

# Plot 10: Pairs
pairs(iris[, 1:4], main = "Plot 10: iris - Pairs",
      col = as.integer(iris$Species))

# Plot 11: Heatmap
mat <- matrix(rnorm(100), nrow = 10)
image(mat, main = "Plot 11: Random Matrix - Heatmap",
      col = heat.colors(20))

# Plot 12: Step plot
plot(x, sin(x), type = "s", col = "darkred", lwd = 2,
     main = "Plot 12: sin(x) - Step")

# --- ggplot2 Plots ---

# Plot 13: ggplot2 Scatter
print(ggplot(iris, aes(Sepal.Length, Sepal.Width, color = Species)) +
  geom_point(size = 2) +
  labs(title = "Plot 13: iris - ggplot2 Scatter") +
  theme_minimal())

# Plot 14: ggplot2 Histogram
print(ggplot(diamonds, aes(x = carat, fill = cut)) +
  geom_histogram(bins = 40, alpha = 0.7) +
  labs(title = "Plot 14: diamonds - ggplot2 Histogram") +
  theme_classic())

# Plot 15: ggplot2 Boxplot
print(ggplot(mtcars, aes(factor(cyl), mpg, fill = factor(cyl))) +
  geom_boxplot() +
  labs(title = "Plot 15: mtcars - ggplot2 Boxplot", x = "Cylinders") +
  theme_bw())

# Plot 16: ggplot2 Line
df <- data.frame(x = x, y = sin(x))
print(ggplot(df, aes(x, y)) +
  geom_line(color = "steelblue", linewidth = 1) +
  labs(title = "Plot 16: sin(x) - ggplot2 Line") +
  theme_minimal())

# Plot 17: ggplot2 Bar
print(ggplot(diamonds, aes(x = cut, fill = cut)) +
  geom_bar() +
  labs(title = "Plot 17: diamonds - ggplot2 Bar") +
  theme_light())

# Plot 18: ggplot2 Density
print(ggplot(iris, aes(x = Petal.Length, fill = Species)) +
  geom_density(alpha = 0.5) +
  labs(title = "Plot 18: iris - ggplot2 Density") +
  theme_minimal())

# Plot 19: ggplot2 Facet
print(ggplot(mtcars, aes(wt, mpg)) +
  geom_point(color = "tomato") +
  facet_wrap(~cyl) +
  labs(title = "Plot 19: mtcars - ggplot2 Facet") +
  theme_bw())

# Plot 20: ggplot2 Violin
print(ggplot(iris, aes(Species, Sepal.Length, fill = Species)) +
  geom_violin(trim = FALSE) +
  geom_jitter(width = 0.1, alpha = 0.3) +
  labs(title = "Plot 20: iris - ggplot2 Violin") +
  theme_minimal())

message("Test tamamlandi. 20 plot bekleniyor.")
