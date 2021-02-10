import chalk from 'chalk';

export class Logger {
  public error(message: string) {
    console.log(chalk.redBright(message));
  }

  public warn(message: string) {
    console.log(chalk.yellow(message));
  }

  public notice(message: string) {
    console.log(chalk.blueBright(message));
  }

  public info(message: string) {
    console.log(message);
  }

  public debug(message: string) {
    console.log(chalk.grey(message));
  }
}
