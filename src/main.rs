mod cli;
mod engine;
mod git;
mod highlight;
mod review;
mod server;
mod store;
mod types;
mod util;

fn main() {
    // Behave like a normal CLI when piped into `head` and the like.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    if let Err(e) = cli::main() {
        eprintln!("sift: {e:#}");
        std::process::exit(1);
    }
}
