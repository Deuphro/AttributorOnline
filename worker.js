onmessage = function(e) {
    console.log(e.toString())
    console.time('Inside the worker')
    let c=0
    for(let k=0;k<50000;k++){for(let i=0;i<5000;i++){c++}}
    console.log('Worker: Message received from main script');
    const result = e.data[0] * e.data[1];
    for(let k=e.data[0];k<e.data[1];k++){
      e.data[2][k]="ticked !"
    }
    if (isNaN(result)) {
      postMessage('Please write two numbers');
    } else {
      const workerResult = 'Result: ' + result;
      console.log('Worker: Posting message back to main script');
      postMessage(workerResult);
      console.timeEnd('Inside the worker')
    }
  }