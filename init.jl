# Suppress external GR/GKS windows as early as possible
ENV["GKSwstype"] = "100"

# Professional Stealth: Minimal footprint with wrap-awareness
if isinteractive()
    try
        len = parse(Int, get(ENV, "VSC_JL_PLOT_LEN", "0"))
        if len > 0
            # Calculate exactly how many lines the command occupied
            w = displaysize(stdout)[2]
            lines = ceil(Int, len / w)
            # Clear that many lines plus one for the execution newline
            print(repeat("\e[A\e[2K", lines), "\r")
        else
            # Fallback
            print("\e[A\e[2K\r")
        end
    catch
        # Silent fallback
        print("\e[A\e[2K\r")
    end
end

script_dir = dirname(@__FILE__)
server_path = joinpath(script_dir, "plot_server.jl")

if isfile(server_path)
    try
        include(server_path)
        # The server script should define RPlotPro module
        if isdefined(Main, :RPlotPro)
            if isdefined(Main.RPlotPro, :start_plot_viewer)
                Main.RPlotPro.start_plot_viewer()
            end
        end
    catch e
        @warn "R Plot Pro: Error during initialization" exception=(e, catch_backtrace())
    end
else
    @warn "R Plot Pro: Could not find plot_server.jl at $server_path"
end

nothing
