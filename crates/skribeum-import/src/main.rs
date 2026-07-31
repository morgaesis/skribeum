use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use skribeum_import::{ImportOptions, import_notion};

#[derive(Debug, Parser)]
#[command(
    name = "skribeum-import",
    version,
    about = "Convert exported workspace content into an Obsidian-compatible Markdown vault"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Import a Notion Markdown and CSV workspace export archive.
    Notion(NotionArgs),
}

#[derive(Debug, Args)]
struct NotionArgs {
    /// Notion "Export all workspace content" ZIP archive.
    archive: PathBuf,

    /// Vault directory to create or update.
    #[arg(long, value_name = "DIR")]
    out: PathBuf,

    /// Print the import plan without creating or changing any files.
    #[arg(long)]
    dry_run: bool,

    /// Allow planned files to be overwritten in an existing output directory.
    #[arg(long)]
    force: bool,
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Notion(args) => import_notion(&ImportOptions {
            archive: args.archive,
            out: args.out,
            dry_run: args.dry_run,
            force: args.force,
        }),
    };

    match result {
        Ok(report) => println!("{report}"),
        Err(error) => {
            eprintln!("error: {error}");
            std::process::exit(1);
        }
    }
}
