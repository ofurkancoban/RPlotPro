# R Plot Pro WebSocket Server - Encapsulated

# Create global hidden environment if it doesn't exist
if (!exists(".vsc_rplot", envir = .GlobalEnv)) {
    assign(".vsc_rplot", new.env(parent = .GlobalEnv), envir = .GlobalEnv)
}

local(
    {
        # Gerekli paketleri yükle
        if (!require("httpuv", quietly = TRUE)) {
            install.packages("httpuv")
        }
        if (!require("jsonlite", quietly = TRUE)) {
            install.packages("jsonlite")
        }
        if (!require("base64enc", quietly = TRUE)) {
            install.packages("base64enc")
        }
        if (!require("svglite", quietly = TRUE)) {
            install.packages("svglite")
        }

        library(httpuv)
        library(jsonlite)
        library(base64enc)
        library(svglite)

        # State variables (now local to this block)
        clients <- list()
        plots <- list() # Stores public info for clients (id, data, timestamp)
        recordings <- list() # Stores internal recordedPlot objects by ID
        server <- NULL
        last_plot <- NULL
        callback_id <- NULL
        client_dims <- list(width = 800, height = 600)
        in_capture <- FALSE
        timer_pending <- FALSE
        last_activity <- Sys.time()

        # Script dizinini bul
        script_dir <- getwd()
        tryCatch(
            {
                if (!is.null(sys.frame(1)$ofile)) {
                    script_dir <- dirname(sys.frame(1)$ofile)
                }
            },
            error = function(e) {}
        )

        # Process resize request
        handle_resize_request <- function(width, height, plot_id = NULL) {
            target_plot <- NULL
            if (!is.null(plot_id)) {
                pid <- as.character(plot_id)
                if (!is.null(recordings[[pid]])) {
                    target_plot <- recordings[[pid]]
                }
            }
            if (is.null(target_plot) && is.null(plot_id)) {
                target_plot <- last_plot
            }
            if (is.null(target_plot)) {
                return(NULL)
            }

            if (width < 50) {
                width <- 50
            }
            if (height < 50) {
                height <- 50
            }

            tryCatch(
                {
                    width_in <- width / 96
                    height_in <- height / 96
                    temp_file <- tempfile(fileext = ".svg")
                    svglite::svglite(
                        filename = temp_file,
                        width = width_in,
                        height = height_in,
                        bg = "white"
                    )
                    replayPlot(target_plot)
                    dev.off()

                    if (file.exists(temp_file)) {
                        plot_data <- base64encode(temp_file)
                        paste0("data:image/svg+xml;base64,", plot_data)
                    } else {
                        NULL
                    }
                },
                error = function(e) {
                    NULL
                },
                finally = {
                    # Always cleanup temp file
                    if (exists("temp_file") && file.exists(temp_file)) {
                        unlink(temp_file)
                    }
                }
            )
        }

        # WebSocket handler
        plot_ws_handler <- function(ws) {
            client_id <- as.character(runif(1))
            ws$onMessage(function(binary, message) {
                tryCatch(
                    {
                        data <- fromJSON(message)
                        if (data$type == "get_plots") {
                            ws$send(toJSON(
                                list(type = "plot_list", plots = plots),
                                auto_unbox = TRUE
                            ))
                        } else if (data$type == "clear_all") {
                            # Assigned to parent scope variables
                            plots <<- list()
                            recordings <<- list()
                        } else if (data$type == "delete_plot") {
                            if (!is.null(data$plot_id)) {
                                pid <- as.character(data$plot_id)
                                recordings[[pid]] <<- NULL
                                plots <<- Filter(
                                    function(x) as.character(x$id) != pid,
                                    plots
                                )
                                ws$send(toJSON(
                                    list(type = "plot_list", plots = plots),
                                    auto_unbox = TRUE
                                ))
                            }
                        } else if (data$type == "resize") {
                            client_dims$width <<- data$width
                            client_dims$height <<- data$height
                            new_plot_data <- handle_resize_request(
                                data$width,
                                data$height,
                                data$plot_id
                            )
                            if (!is.null(new_plot_data)) {
                                if (!is.null(data$plot_id)) {
                                    idx <- 0
                                    for (i in seq_along(plots)) {
                                        if (
                                            as.character(plots[[i]]$id) ==
                                                as.character(data$plot_id)
                                        ) {
                                            idx <- i
                                            break
                                        }
                                    }
                                    if (idx > 0) {
                                        plots[[idx]]$data <<- new_plot_data
                                    }
                                }
                                ws$send(toJSON(
                                    list(
                                        type = "update_plot",
                                        plot_id = data$plot_id,
                                        data = new_plot_data
                                    ),
                                    auto_unbox = TRUE
                                ))
                            }
                        } else if (data$type == "set_active_file") {
                            # Functionality removed as per cleanup
                        }
                    },
                    error = function(e) {}
                )
            })
            ws$onClose(function() {
                clients[[client_id]] <<- NULL
            })
            clients[[client_id]] <<- ws
            if (length(plots) > 0) {
                ws$send(toJSON(
                    list(type = "plot_list", plots = plots),
                    auto_unbox = TRUE
                ))
            }
        }

        # HTTP handler
        plot_http_handler <- function(req) {
            if (req$PATH_INFO == "/") {
                html_file <- file.path(script_dir, "plot_viewer.html")
                if (!file.exists(html_file)) {
                    html_file <- "plot_viewer.html"
                }
                if (file.exists(html_file)) {
                    html_content <- readLines(html_file, warn = FALSE)
                    list(
                        status = 200L,
                        headers = list("Content-Type" = "text/html"),
                        body = paste(html_content, collapse = "\n")
                    )
                } else {
                    list(
                        status = 404L,
                        headers = list("Content-Type" = "text/plain"),
                        body = "Not found"
                    )
                }
            } else {
                list(
                    status = 404L,
                    headers = list("Content-Type" = "text/plain"),
                    body = "Not found"
                )
            }
        }

        send_plot_to_clients <- function(plot_data, metadata = list()) {
            message <- toJSON(
                list(type = "new_plot", data = plot_data, metadata = metadata),
                auto_unbox = TRUE
            )
            for (client in clients) {
                tryCatch(client$send(message), error = function(e) {})
            }
        }


        process_internal_capture <- function(
            current_plot,
            explicit_source_info = NULL
        ) {
            if (is.null(current_plot)) {
                return()
            }
            if (!identical(current_plot, last_plot)) {
                width_px <- client_dims$width
                height_px <- client_dims$height
                width_in <- max(width_px / 96, 2)
                height_in <- max(height_px / 96, 2)

                temp_file <- tempfile(fileext = ".svg")
                svglite::svglite(
                    filename = temp_file,
                    width = width_in,
                    height = height_in,
                    bg = "white"
                )
                replayPlot(current_plot)
                dev.off()

                if (file.exists(temp_file)) {
                    fsize <- file.size(temp_file)
                    if (fsize < 400) {
                        unlink(temp_file)
                        return()
                    }
                    plot_data <- base64encode(temp_file)
                    plot_data_uri <- paste0(
                        "data:image/svg+xml;base64,",
                        plot_data
                    )
                    id <- as.character(as.numeric(Sys.time()) * 1000)

                    # Determine source code information
                    source_info <- NULL

                    if (!is.null(explicit_source_info)) {
                        # Use provided info (e.g. from hook capturing previous plot)
                        source_info <- explicit_source_info
                    }

                    plot_metadata <- list(
                        id = id,
                        data = plot_data_uri,
                        timestamp = format(Sys.time(), "%H:%M:%S"),
                        width = "100%",
                        height = "auto"
                    )

                    # Add source info if available


                    # Memory leak prevention: enforce MAX_PLOTS limit
                    MAX_PLOTS <- 200
                    if (length(plots) >= MAX_PLOTS) {
                        # Remove oldest plot
                        oldest_id <- plots[[1]]$id
                        recordings[[oldest_id]] <<- NULL
                        plots <<- plots[-1]
                    }

                    plots[[length(plots) + 1]] <<- plot_metadata
                    recordings[[id]] <<- current_plot
                    last_plot <<- current_plot

                    send_plot_to_clients(
                        plot_data_uri,
                        plot_metadata
                    )
                    unlink(temp_file)
                }
            }
        }

        on_plot_new_hook <- function() {
            # 1. If there's a finished plot on the device, capture it NOW
            if (dev.cur() > 1) {
                tryCatch(
                    {
                        mfg <- par("mfg")
                        is_last_cell <- (mfg[1] == mfg[3] && mfg[2] == mfg[4])
                        if (is_last_cell) {
                            current_plot <- recordPlot()
                            process_internal_capture(current_plot)
                        }
                    },
                    error = function(e) {}
                )
            }
        }
        .vsc_rplot$.on_plot_new_hook <- on_plot_new_hook

        # Special hook for ggplot plots - now just an alias as we don't capture source
        on_ggplot_print_hook <- function() {
            on_plot_new_hook()
        }
        .vsc_rplot$.on_ggplot_print_hook <- on_ggplot_print_hook

        check_for_new_plot <- function(expr, value, ok, visible) {
            if (dev.cur() > 1) {
                tryCatch(
                    {
                        current_plot <- recordPlot()
                        process_internal_capture(current_plot)
                    },
                    error = function(e) {}
                )
            }
            return(TRUE)
        }

        vscode_bg_device <- function(...) {
            svglite::svglite(
                filename = tempfile(),
                width = 10,
                height = 6,
                bg = "white",
                ...
            )
            dev.control("enable")
        }

        # Public functions assigned to .vsc_rplot
        .vsc_rplot$start_plot_viewer <- function(port = NULL) {
            if (!is.null(server)) {
                stopServer(server)
                server <<- NULL
            }
            if (is.null(port)) {
                port <- sample(10000:30000, 1)
            }

            env_config_path <- Sys.getenv("VSCODE_R_PLOT_CONFIG")
            local_config_file <- if (nzchar(env_config_path)) {
                env_config_path
            } else {
                file.path(getwd(), ".r_plot_config.json")
            }

            writeLines(
                jsonlite::toJSON(list(port = port), auto_unbox = TRUE),
                local_config_file
            )

            tryCatch(
                {
                    server <<- startServer(
                        host = "127.0.0.1",
                        port = port,
                        app = list(
                            call = plot_http_handler,
                            onWSOpen = plot_ws_handler
                        )
                    )
                },
                error = function(e) {
                    if (
                        grepl(
                            "address already in use",
                            e$message,
                            ignore.case = TRUE
                        )
                    ) {
                        system(
                            sprintf("lsof -ti:%d | xargs kill -9", port),
                            ignore.stderr = TRUE
                        )
                        Sys.sleep(1)
                        server <<- startServer(
                            host = "127.0.0.1",
                            port = port,
                            app = list(
                                call = plot_http_handler,
                                onWSOpen = plot_ws_handler
                            )
                        )
                    } else {
                        stop(e)
                    }
                }
            )

            if (is.null(server)) {
                return(invisible(NULL))
            }

            options(device = vscode_bg_device)
            if (!is.null(callback_id)) {
                removeTaskCallback(callback_id)
            }
            callback_id <<- addTaskCallback(
                check_for_new_plot,
                name = "plot_viewer_watcher"
            )

            tryCatch(
                {
                    suppressMessages(trace(
                        graphics::plot.new,
                        print = FALSE,
                        tracer = quote(.vsc_rplot$.on_plot_new_hook()),
                        where = asNamespace("graphics")
                    ))
                    if (requireNamespace("grid", quietly = TRUE)) {
                        suppressMessages(trace(
                            grid::grid.newpage,
                            print = FALSE,
                            tracer = quote(.vsc_rplot$.on_plot_new_hook()),
                            where = asNamespace("grid")
                        ))
                    }
                    if (requireNamespace("ggplot2", quietly = TRUE)) {
                        suppressMessages(trace(
                            ggplot2::print.ggplot,
                            print = FALSE,
                            tracer = quote(.vsc_rplot$.on_ggplot_print_hook()),
                            where = asNamespace("ggplot2")
                        ))
                    }
                },
                error = function(e) {}
            )

            invisible(server)
        }

        .vsc_rplot$stop_plot_viewer <- function() {
            if (!is.null(server)) {
                stopServer(server)
                server <<- NULL
            }
            if (!is.null(callback_id)) {
                removeTaskCallback(callback_id)
                callback_id <<- NULL
            }
            tryCatch(
                {
                    suppressMessages(untrace(
                        "plot.new",
                        where = asNamespace("graphics")
                    ))
                    if (requireNamespace("grid", quietly = TRUE)) {
                        suppressMessages(untrace(
                            "grid.newpage",
                            where = asNamespace("grid")
                        ))
                    }
                    if (requireNamespace("ggplot2", quietly = TRUE)) {
                        suppressMessages(untrace(
                            "print.ggplot",
                            where = asNamespace("ggplot2")
                        ))
                    }
                },
                error = function(e) {}
            )
        }

        .vsc_rplot$clear_plots <- function() {
            plots <<- list()
            recordings <<- list()
            last_plot <<- NULL
            msg <- toJSON(list(type = "clear_plots"), auto_unbox = TRUE)
            for (c in clients) {
                tryCatch(c$send(msg), error = function(e) {})
            }
        }

        # Expose run_file helper (noop now but kept for compatibility)
        .vsc_rplot$run_file <- function(file_path) {
             # source highlighting disabled
             utils::source(file_path)
             invisible(NULL)
        }
    },
    envir = .vsc_rplot
)
